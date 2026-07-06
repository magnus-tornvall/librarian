import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

// The curated recall path, imported from the exact modules the roadmap names.
// This capstone is the wiring map for roadmap item 5: curated Markdown → human
// distiller → note log → FTS5 index → recall, with the §6 human/curated weight
// visibly deciding the ranking. Each import below is one pipeline stage.
import { importCuratedNote } from '../src/distill/humanDistiller.ts'; // human distiller (import + rename)
import { appendNote, readAllNotes } from '../src/log/noteLog.ts'; // note log
import { exportNoteToVault } from '../src/export/obsidian.ts'; // Obsidian export (generated/)
import { migrate } from '../src/index/schema.ts'; // FTS5 schema
import { indexNotes } from '../src/index/indexer.ts'; // tombstone-aware indexer
import { recall } from '../src/recall/query.ts'; // recall query
import { DEFAULT_SCORING_CONFIG } from '../src/recall/scoring.ts'; // §6 weights (human 1.5 × curated 1.4)

// A fixed "now" so recency decay is deterministic across machines and runs. All
// notes below are dated near this instant; ties on created_at cancel the decay
// term so the §6 origin/note_type WEIGHTS — not recency luck — decide the order.
const NOW = '2026-07-06T12:00:00.000Z';
const VINTAGE = '2026-07-06T10:00:00.000Z';

/** One fresh set of temp dirs per run so the test never touches ~/.librarian. */
function makeTempDirs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'curated-path-'));
  const vaultDir = path.join(root, 'vault');
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(path.join(vaultDir, 'curated'), { recursive: true });
  fs.mkdirSync(path.join(vaultDir, 'generated'), { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  return { root, vaultDir, dataDir, cursorPath: path.join(dataDir, 'cursor.json') };
}

function writeCurated(vaultDir: string, relPath: string, content: string): string {
  const filePath = path.join(vaultDir, 'curated', relPath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  return filePath;
}

/**
 * Decoy corpus. FTS5's bm25() IDF term collapses to ~0 when a term appears in a
 * tiny single-document corpus, so a lone note scores below the relevance floor
 * and recall returns []. Realistic filler (none of it containing the distinctive
 * query terms below) gives bm25 a nonzero, honest score for the notes under test
 * — mirrors the decoy idiom in tests/recall/query.test.ts and the indexer test.
 */
function seedDecoyNotes(dataDir: string): void {
  for (let i = 0; i < 5; i += 1) {
    appendNote(dataDir, {
      kind: 'note_revision',
      schema_version: 1,
      note_id: `decoy:${i}`,
      revision_id: `decoy-rev-${i}`,
      created_at: VINTAGE,
      identity: { mode: 'episodic' },
      source: { origin: 'opencode', distiller: 'llm' },
      note_type: 'fact',
      title: `Unrelated filler note ${i}`,
      scope: {},
      provenance: {},
      links: [],
      body: { summary: `Miscellaneous unrelated content number ${i} about assorted topics.` },
    });
  }
}

/** Migrate a fresh in-memory index and run the full-rescan indexer over dataDir. */
function freshIndex(dataDir: string, cursorPath: string): Database.Database {
  const db = new Database(':memory:');
  migrate(db);
  indexNotes(db, dataDir, cursorPath);
  return db;
}

// --- Section 1: Golden path -------------------------------------------------
// A curated Markdown fixture → import → index → recall (global) returns it as a
// human-authored curated note.

test('curated path §1 golden: curated Markdown imports, indexes, and recalls as human/curated', () => {
  const t = makeTempDirs();
  seedDecoyNotes(t.dataDir);

  // "quokka" is a distinctive term the decoys never use, so bm25's IDF stays high.
  const filePath = writeCurated(
    t.vaultDir,
    'quokka-runbook.md',
    '# Quokka deployment runbook\n\nThe quokka service ships via the quokka release pipeline.\n',
  );

  const imported = importCuratedNote(t.vaultDir, filePath, t.dataDir);
  assert.equal(imported.source.origin, 'human', '§1 import: curated note origin must be human');
  assert.equal(imported.note_type, 'curated', '§1 import: note_type must be curated');

  const db = freshIndex(t.dataDir, t.cursorPath);
  const results = recall(db, 'quokka', { global: true }, DEFAULT_SCORING_CONFIG, NOW);

  assert.equal(results.length, 1, '§1 recall: expected exactly one result for the curated query term');
  assert.equal(results[0].note_id, imported.note_id, '§1 recall: the result must be the imported curated note');
  assert.equal(results[0].origin, 'human', '§1 recall: recalled origin must be human');
  assert.equal(results[0].note_type, 'curated', '§1 recall: recalled note_type must be curated');
});

// --- Section 2: Human weight assertion --------------------------------------
// A curated note and an LLM episodic note match the same query with COMPARABLE
// lexical strength and the SAME created_at vintage. The §6 weights (human 1.5 ×
// curated 1.4 = 2.1 vs opencode 1.0 × episode 0.7 = 0.7) — not luck — must put
// the curated note strictly above. Lexical content is kept parallel so the
// assertion is honest: if the weights were equal, the two would tie.

test('curated path §2 human weight: curated (2.1) ranks strictly above an LLM episode (0.7) at equal lexis', () => {
  const t = makeTempDirs();
  seedDecoyNotes(t.dataDir);

  // Both notes carry the shared term "numbat" with the same frequency inside a
  // same-length body, so their raw bm25 is comparable. The only thing that can
  // separate them is the origin/note_type weight product.
  const sharedSummary = 'The numbat rollback numbat procedure numbat covers numbat staging.';

  // LLM episodic note, seeded straight onto the note log (origin opencode, episode).
  appendNote(t.dataDir, {
    kind: 'note_revision',
    schema_version: 1,
    note_id: 'episode:numbat-episode',
    revision_id: 'numbat-episode-rev',
    created_at: VINTAGE,
    identity: { mode: 'episodic' },
    source: { origin: 'opencode', distiller: 'llm' },
    note_type: 'episode',
    title: 'Numbat rollback episode',
    scope: { global: true },
    provenance: {},
    links: [],
    body: { summary: sharedSummary },
  });

  // Curated note with the SAME lexical payload, imported through the real human
  // distiller so this is the genuine curated pipeline, not a hand-built row.
  const curatedFile = writeCurated(t.vaultDir, 'numbat-runbook.md', `# Numbat rollback episode\n\n${sharedSummary}\n`);
  const curated = importCuratedNote(t.vaultDir, curatedFile, t.dataDir);

  const db = freshIndex(t.dataDir, t.cursorPath);
  const results = recall(db, 'numbat', { global: true }, DEFAULT_SCORING_CONFIG, NOW);

  // Both notes must be present, and both must clear the floor, or the comparison
  // would be vacuous.
  const curatedResult = results.find((r) => r.note_id === curated.note_id);
  const episodeResult = results.find((r) => r.note_id === 'episode:numbat-episode');
  assert.ok(curatedResult, '§2 precondition: the curated note must be recalled');
  assert.ok(episodeResult, '§2 precondition: the LLM episode must also be recalled (honest comparison)');

  // Honesty check: with the same created_at and comparable bm25, the raw scores
  // are close — so the WEIGHTS are what open the gap, not lexical luck.
  const rawRatio = curatedResult.raw_bm25 / episodeResult.raw_bm25;
  assert.ok(
    rawRatio > 0.8 && rawRatio < 1.25,
    `§2 honesty: raw bm25 must be comparable before weighting (ratio ${rawRatio.toFixed(3)})`,
  );

  // The decisive assertion: curated strictly above the episode.
  assert.ok(
    curatedResult.score > episodeResult.score,
    `§2 human weight: curated (${curatedResult.score.toFixed(4)}) must rank strictly above episode (${episodeResult.score.toFixed(4)})`,
  );
  assert.equal(results[0].note_id, curated.note_id, '§2 human weight: curated must be the top result');

  // And the gap must be the weight ratio (2.1 / 0.7 = 3.0), within bm25 noise —
  // proving the weights, not recency or luck, decided it.
  const scoreRatio = curatedResult.score / episodeResult.score;
  const weightRatio = (DEFAULT_SCORING_CONFIG.originWeights.human * DEFAULT_SCORING_CONFIG.typeWeights.curated) /
    (DEFAULT_SCORING_CONFIG.originWeights.opencode * DEFAULT_SCORING_CONFIG.typeWeights.episode);
  assert.ok(
    Math.abs(scoreRatio - weightRatio * rawRatio) < 0.05,
    `§2 human weight: score ratio ${scoreRatio.toFixed(3)} must track weight×bm25 ratio ${(weightRatio * rawRatio).toFixed(3)}`,
  );
});

// --- Section 3: Negative fixture (§9 — superseded decision) ------------------
// An older LLM `decision` note is superseded by a newer curated note. The
// curated replacement must rank strictly above the superseded decision for the
// shared query — the §9 "a superseded decision is not preferred over its newer
// curated replacement" fixture.

test('curated path §3 superseded decision: newer curated replacement ranks above the stale LLM decision', () => {
  const t = makeTempDirs();
  seedDecoyNotes(t.dataDir);

  const sharedTerm = 'wombat';

  // Older LLM decision note (origin opencode, decision), created earlier.
  appendNote(t.dataDir, {
    kind: 'note_revision',
    schema_version: 1,
    note_id: 'decision:wombat-auth-old',
    revision_id: 'wombat-auth-old-rev',
    created_at: '2026-06-01T10:00:00.000Z',
    identity: { mode: 'episodic' },
    source: { origin: 'opencode', distiller: 'llm' },
    note_type: 'decision',
    title: 'Wombat auth decision (superseded)',
    scope: { global: true },
    provenance: {},
    links: [],
    body: { summary: `The old ${sharedTerm} auth decision chose the ${sharedTerm} legacy token flow.` },
  });

  // Newer curated note that supersedes it, imported through the human distiller.
  const curatedFile = writeCurated(
    t.vaultDir,
    'wombat-auth.md',
    `# Wombat auth decision (current)\n\nThe current ${sharedTerm} auth decision adopts the ${sharedTerm} rotating token flow.\n`,
  );
  const replacement = importCuratedNote(t.vaultDir, curatedFile, t.dataDir);

  const db = freshIndex(t.dataDir, t.cursorPath);
  const results = recall(db, sharedTerm, { global: true }, DEFAULT_SCORING_CONFIG, NOW);

  const replacementResult = results.find((r) => r.note_id === replacement.note_id);
  const staleResult = results.find((r) => r.note_id === 'decision:wombat-auth-old');
  assert.ok(replacementResult, '§3 precondition: the curated replacement must be recalled');
  assert.ok(staleResult, '§3 precondition: the superseded decision must still be recalled (both compete)');

  assert.ok(
    replacementResult.score > staleResult.score,
    `§3 superseded: curated replacement (${replacementResult.score.toFixed(4)}) must rank strictly above the stale decision (${staleResult.score.toFixed(4)})`,
  );
  assert.equal(results[0].note_id, replacement.note_id, '§3 superseded: the curated replacement must be the top result');
});

// --- Section 4: Rename end-to-end -------------------------------------------
// Import a path-hash-identity curated file, rename it in the vault, re-import,
// re-index. Recall must return exactly ONE result for its query — the NEW
// note_id — proving the tombstone flowed importer → log → indexer → recall.

test('curated path §4 rename: a renamed curated file recalls exactly one result under its new note_id', () => {
  const t = makeTempDirs();
  seedDecoyNotes(t.dataDir);

  // No frontmatter note_id → path-hash identity, which is what rename detection keys on.
  const content = '# Bilby migration guide\n\nThe bilby migration guide walks through the bilby cutover.\n';
  const oldPath = writeCurated(t.vaultDir, 'bilby-old.md', content);
  const original = importCuratedNote(t.vaultDir, oldPath, t.dataDir);

  // Rename in the vault: remove the old path, write identical content at the new path.
  fs.unlinkSync(oldPath);
  const newPath = writeCurated(t.vaultDir, 'bilby-new.md', content);
  const renamed = importCuratedNote(t.vaultDir, newPath, t.dataDir);

  assert.notEqual(renamed.note_id, original.note_id, '§4 rename: a path-hash rename mints a new note_id');

  // A tombstone for the OLD note_id must have been written to the log by the importer.
  const stored = readAllNotes(t.dataDir) as Array<Record<string, unknown>>;
  const tombstone = stored.find(
    (r) => r.kind === 'note_tombstone' && r.note_id === original.note_id,
  );
  assert.ok(tombstone, '§4 rename: the importer must tombstone the old note_id');

  const db = freshIndex(t.dataDir, t.cursorPath);
  const results = recall(db, 'bilby', { global: true }, DEFAULT_SCORING_CONFIG, NOW);

  assert.equal(results.length, 1, '§4 rename: recall must return exactly ONE result (old id tombstoned out)');
  assert.equal(results[0].note_id, renamed.note_id, '§4 rename: the surviving result must be the NEW note_id');
  assert.notEqual(results[0].note_id, original.note_id, '§4 rename: the old note_id must not appear in recall');
});

// --- Section 5: Generated exclusion end-to-end (§9) --------------------------
// Export a note into the same temp vault via exportNoteToVault, then assert the
// importer refuses it AND the note log gained no record from the attempt — the
// §9 "generated exports are not re-ingested" fixture.

test('curated path §5 generated exclusion: an exported note is refused by the importer and never logged', () => {
  const t = makeTempDirs();

  const exportable = {
    kind: 'note_revision',
    schema_version: 1,
    note_id: 'decision:dingo-export',
    revision_id: 'dingo-export-rev',
    created_at: VINTAGE,
    identity: { mode: 'episodic' },
    source: { origin: 'opencode', distiller: 'llm' },
    note_type: 'decision',
    title: 'Dingo export decision',
    scope: { global: true },
    provenance: {},
    links: [],
    body: { summary: 'A generated dingo export that must never be re-ingested by the curated importer.' },
  };

  // Export writes under <vault>/generated/**, self-identifying with the
  // librarian_generated frontmatter + marker.
  const exportedPath = exportNoteToVault(t.vaultDir, exportable);
  assert.ok(fs.existsSync(exportedPath), '§5 precondition: the exported file must exist on disk');
  assert.ok(
    exportedPath.startsWith(path.join(t.vaultDir, 'generated') + path.sep),
    '§5 precondition: the export must live under the vault generated/ tree',
  );

  const notesBefore = readAllNotes(t.dataDir).length;

  // The importer must refuse a generated export. It lives under generated/, so
  // the directory check alone rejects it; the assertion is on refusal + no log
  // record, not on the specific message.
  assert.throws(
    () => importCuratedNote(t.vaultDir, exportedPath, t.dataDir),
    /generated|curated/i,
    '§5 exclusion: the importer must refuse a generated export',
  );

  const notesAfter = readAllNotes(t.dataDir).length;
  assert.equal(notesAfter, notesBefore, '§5 exclusion: the note log must gain no record from the refused import');
});
