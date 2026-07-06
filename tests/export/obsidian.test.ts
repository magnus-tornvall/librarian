import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { exportNoteToVault } from '../../src/export/obsidian.ts';

function tempVaultDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'obsidian-export-test-'));
}

// Modeled on task 018's example note shape (schema/examples/note/01-*.json):
// an episodic decision note with a `{type}:{ulid}` note_id (note the colon).
function exampleNote(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'note_revision',
    schema_version: 1,
    note_id: 'decision:01J8X9F1TZ6R3M8N0P5Q7S9VWX',
    revision_id: '01J8X9F1TZ6R3M8N0P5Q7S9VWY',
    created_at: '2026-07-05T10:00:00.000Z',
    identity: { mode: 'episodic' },
    source: { origin: 'opencode', distiller: 'llm', model: 'claude-sonnet-5', agent: 'opencode' },
    note_type: 'decision',
    title: 'Adopt BM25-over-SQLite-FTS5 as the sole recall index',
    scope: { project_slug: 'librarian' },
    provenance: {},
    links: [],
    body: {
      summary: 'BM25 over SQLite FTS5 is the one blessed index for v1; no recall provider abstraction.',
      bullets: [
        'Schema must not block later vector search, but nothing more is built now.',
        'Re-ranking is the named first upgrade, trigger-gated on negative fixtures.',
      ],
    },
    ...overrides,
  };
}

// Recursively collect every file path under a directory.
function walkFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walkFiles(full) : [full];
  });
}

test('exports a note to generated/<note_type>/<sanitized note_id>.md with librarian_generated frontmatter', () => {
  const vaultDir = tempVaultDir();
  const written = exportNoteToVault(vaultDir, exampleNote());

  const expected = path.join(
    vaultDir,
    'generated',
    'decision',
    'decision-01J8X9F1TZ6R3M8N0P5Q7S9VWX.md',
  );
  assert.equal(written, expected);
  assert.ok(fs.existsSync(expected), 'exported file should exist at the deterministic path');

  const content = fs.readFileSync(expected, 'utf8');
  assert.match(content, /librarian_generated: true/);
  assert.match(content, /<!-- librarian:generated; do not edit -->/);
  assert.match(content, /# Adopt BM25-over-SQLite-FTS5 as the sole recall index/);
  assert.match(content, /BM25 over SQLite FTS5 is the one blessed index/);
  // Bullets render as a Markdown list.
  assert.match(content, /- Schema must not block later vector search/);
  // origin comes from note.source.origin.
  assert.match(content, /origin: "opencode"/);
});

test('re-exporting the same note_id with a new title overwrites (exactly one file, new title)', () => {
  const vaultDir = tempVaultDir();
  exportNoteToVault(vaultDir, exampleNote({ title: 'First title' }));
  const written = exportNoteToVault(vaultDir, exampleNote({ title: 'Second title' }));

  const decisionDir = path.join(vaultDir, 'generated', 'decision');
  const files = fs.readdirSync(decisionDir);
  assert.equal(files.length, 1, 'same note_id must map to exactly one file');

  const content = fs.readFileSync(written, 'utf8');
  assert.match(content, /# Second title/);
  assert.doesNotMatch(content, /# First title/);
});

test('nothing is ever written under curated/ (structural invariant §5, task 008)', () => {
  const vaultDir = tempVaultDir();
  exportNoteToVault(vaultDir, exampleNote());
  exportNoteToVault(vaultDir, exampleNote({ note_id: 'fact:01J8X9F1TZ6R3M8N0P5Q7S9AAA', note_type: 'fact' }));

  // Grep-equivalent: no file the exporter produced lands under a curated/ segment.
  const allFiles = walkFiles(vaultDir);
  assert.ok(allFiles.length > 0, 'exporter should have written at least one file');
  const curatedFiles = allFiles.filter((p) => p.split(path.sep).includes('curated'));
  assert.deepEqual(curatedFiles, [], `no file may be written under curated/, found: ${curatedFiles.join(', ')}`);
  // Every produced file lives under generated/.
  for (const file of allFiles) {
    assert.ok(
      file.split(path.sep).includes('generated'),
      `expected ${file} to live under generated/`,
    );
  }
});
