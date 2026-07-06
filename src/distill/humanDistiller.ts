import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ulid } from 'ulid';
import type { NoteRevision } from '../note.ts';
import { appendNote } from '../log/noteLog.ts';

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

  const note: NoteRevision = {
    kind: 'note_revision',
    schema_version: 1,
    note_id: noteId,
    revision_id: ulid(),
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
  return note;
}
