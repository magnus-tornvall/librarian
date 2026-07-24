import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ulid } from 'ulid';
import type { NoteRecord, NoteRevision, NoteTombstone } from '../note.ts';
import { appendNote, readAllNotes } from '../log/noteLog.ts';

/**
 * Human distiller (curated-note importer, §5 "Human curation"). The human already
 * did the judging; this module only serializes Markdown under `<vaultDir>/curated/`
 * into a `NoteRevision` and appends it to the note log. No LLM, no generic import
 * path — the two structural invariants below are enforced by construction, not
 * by a frontmatter-based filter list (docs/specs/structural-invariants.md #1, #2).
 */

const GENERATED_MARKER = '<!-- librarian:generated';

/** Diagnostic records are poison-pilled by `record_class` (§8) — matches YAML
 * (`record_class: diagnostic`) and JSON (`"record_class":"diagnostic"`) shapes. */
const DIAGNOSTIC_RECORD_PATTERN = /record_class["']?\s*:\s*["']?diagnostic/i;

function splitFrontmatter(content: string): { frontmatter: Record<string, string>; body: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) {
    return { frontmatter: {}, body: content };
  }
  const frontmatter: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (kv) {
      frontmatter[kv[1]] = kv[2].trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
    }
  }
  return { frontmatter, body: content.slice(match[0].length) };
}

function deriveTitle(body: string, fallbackFileName: string): string {
  const heading = body.match(/^#\s+(.+)$/m);
  return heading ? heading[1].trim() : path.basename(fallbackFileName, '.md');
}

function deriveSummary(body: string): string {
  const paragraph = body
    .split(/\r?\n\s*\r?\n/)
    .map((p) => p.trim())
    .find((p) => p.length > 0 && !p.startsWith('#'));
  return paragraph ?? '';
}

/**
 * Build a human revision of an existing note (spec §5 human-revision ruling —
 * terminal `note edit` #107, MCP `revise_note` #110). Identity follows the
 * judgment, not the keyboard: `distiller` becomes 'human' and `previous_revision_id`
 * chains to the prior revision, while origin, note_type, scope, identity, title,
 * links, and provenance carry over unchanged — latest-wins does the rest. The
 * approved body is the source, so the prior revision's `source_path`/`content_hash`
 * (which described other bytes) are intentionally dropped.
 *
 * `agent` records the mediating channel — the MCP client identity for `revise_note`,
 * unset for terminal `note edit`. That is the only structural signal distinguishing
 * the two channels under `note show --with-provenance` (spec §5: the tool-contract
 * approval wording is a prior, not a guard).
 */
export function buildHumanRevision(prior: NoteRevision, body: string, agent?: string): NoteRevision {
  return {
    kind: 'note_revision',
    schema_version: 1,
    note_id: prior.note_id,
    revision_id: ulid(),
    previous_revision_id: prior.revision_id,
    created_at: new Date().toISOString(),
    // A content-only edit inherits the note's declared validity window unchanged — it must
    // not silently resurrect an expired note or make a not-yet-valid one live. Changing the
    // window is a deliberate act, not a side effect of correcting the body.
    ...(prior.valid_at ? { valid_at: prior.valid_at } : {}),
    ...(prior.invalid_at ? { invalid_at: prior.invalid_at } : {}),
    identity: prior.identity,
    source: { origin: prior.source.origin, distiller: 'human', ...(agent ? { agent } : {}) },
    note_type: prior.note_type,
    title: prior.title,
    scope: prior.scope,
    provenance: prior.provenance,
    links: prior.links,
    body: { summary: deriveSummary(body), details: body },
  };
}

type NoteIdState = { revision: NoteRevision; tombstoned: boolean };

/** Latest revision per note_id plus whether a tombstone came after it (log append order). */
function latestStatePerNoteId(records: NoteRecord[]): Map<string, NoteIdState> {
  const state = new Map<string, NoteIdState>();
  for (const record of records) {
    if (record.kind === 'note_revision') {
      state.set(record.note_id, { revision: record, tombstoned: false });
    } else {
      const existing = state.get(record.note_id);
      if (existing) {
        existing.tombstoned = true;
      }
    }
  }
  return state;
}

/**
 * Import one curated Markdown file into the note log. Every rejection below is a
 * thrown error naming the invariant violated — quarantine-with-error, never a
 * silent skip (§8 poison-pill semantics apply to this importer too).
 */
export function importCuratedNote(vaultDir: string, filePath: string, dataDir: string): NoteRevision {
  const resolvedVault = fs.realpathSync(vaultDir);
  const resolvedFile = fs.realpathSync(filePath);
  const curatedRoot = path.join(resolvedVault, 'curated') + path.sep;

  // Generated exclusion (§1): scope by directory, not by inspecting frontmatter.
  if (!resolvedFile.startsWith(curatedRoot)) {
    throw new Error(
      `human distiller: ${filePath} is not under ${path.join(vaultDir, 'curated')} — refused (generated/curated split)`,
    );
  }

  const content = fs.readFileSync(resolvedFile, 'utf8');

  // Diagnostics isolation (§2): poison-pill hard-reject, regardless of extension.
  if (DIAGNOSTIC_RECORD_PATTERN.test(content)) {
    throw new Error(`human distiller: ${filePath} declares record_class: diagnostic — refused (diagnostics isolation)`);
  }
  if (path.extname(resolvedFile) !== '.md') {
    throw new Error(`human distiller: ${filePath} is not a .md file — refused (diagnostics isolation)`);
  }

  const { frontmatter, body } = splitFrontmatter(content);

  // Generated exclusion, belt and braces: refuse exporter output even if someone
  // moved it under curated/ by hand.
  if (frontmatter.librarian_generated === 'true' || content.includes(GENERATED_MARKER)) {
    throw new Error(`human distiller: ${filePath} is librarian_generated — refused (generated/curated split)`);
  }

  const relPath = path.relative(resolvedVault, resolvedFile);
  // Deterministic fallback when no frontmatter note_id is declared: hex SHA-256 of
  // the vault-relative path, stable across runs (full digest, truncation not needed).
  const noteId = frontmatter.note_id ?? `curated:${createHash('sha256').update(relPath).digest('hex')}`;
  const contentHash = `sha256:${createHash('sha256').update(content).digest('hex')}`;

  // ponytail: full-log rescan per file, fine at v1 scale; a future batch importer
  // looping over thousands of curated files should hoist this scan to run once.
  const latestByNoteId = latestStatePerNoteId(readAllNotes(dataDir) as NoteRecord[]);
  const noteIdState = latestByNoteId.get(noteId);
  // A tombstoned note_id is dead — resurrecting it (e.g. the old path reappears)
  // must mint a fresh revision, never silently resume as "unchanged" or "edited".
  const existing = noteIdState && !noteIdState.tombstoned ? noteIdState.revision : undefined;

  // Idempotency (§5): re-import of the same file at the same path with unchanged
  // content mints nothing. A path change still mints a revision so `source_path`
  // stays accurate, even when content (and thus content_hash) didn't move.
  if (existing && existing.source.content_hash === contentHash && existing.source.source_path === relPath) {
    return existing;
  }

  let previousRevisionId: string | undefined;
  let renameTombstone: NoteTombstone | undefined;

  if (existing) {
    previousRevisionId = existing.revision_id;
  } else if (!frontmatter.note_id) {
    // Rename detection is path-hash identity only (§5): an explicit frontmatter
    // note_id travels with the content and is always caught by the `existing`
    // branch above, never here.
    // ponytail: first matching candidate wins if two distinct notes ever share a
    // content_hash (e.g. identical boilerplate) — exact-hash rename detection
    // can't disambiguate further without the fuzzy matching §15 defers.
    for (const [candidateId, candidateState] of latestByNoteId) {
      const candidate = candidateState.revision;
      const oldSourcePath = candidate.source.source_path;
      if (
        candidateState.tombstoned ||
        candidateId === noteId ||
        candidate.source.content_hash !== contentHash ||
        !oldSourcePath ||
        fs.existsSync(path.join(resolvedVault, oldSourcePath))
      ) {
        continue;
      }
      renameTombstone = {
        kind: 'note_tombstone',
        schema_version: 1,
        note_id: candidateId,
        revision_id: ulid(),
        previous_revision_id: candidate.revision_id,
        reason: 'renamed',
        created_at: new Date().toISOString(),
        source: { kind: 'human' },
      };
      break;
    }
  }

  const note: NoteRevision = {
    kind: 'note_revision',
    schema_version: 1,
    note_id: noteId,
    revision_id: ulid(),
    ...(previousRevisionId ? { previous_revision_id: previousRevisionId } : {}),
    created_at: new Date().toISOString(),
    identity: { mode: 'deterministic', key: noteId },
    source: { origin: 'human', distiller: 'human', source_path: relPath, content_hash: contentHash },
    note_type: 'curated',
    title: deriveTitle(body, resolvedFile),
    // A curated note recall can never see is useless (v1 default: global).
    scope: frontmatter.project_slug ? { project_slug: frontmatter.project_slug } : { global: true },
    provenance: {},
    links: [],
    body: { summary: deriveSummary(body), details: body },
  };

  appendNote(dataDir, note);
  if (renameTombstone) {
    appendNote(dataDir, renameTombstone);
  }
  return note;
}
