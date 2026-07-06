import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { importCuratedNote } from '../../src/distill/humanDistiller.ts';
import { readAllNotes } from '../../src/log/noteLog.ts';

function tempVaultDir(): string {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'human-distiller-vault-'));
  fs.mkdirSync(path.join(vaultDir, 'curated'), { recursive: true });
  fs.mkdirSync(path.join(vaultDir, 'generated'), { recursive: true });
  return vaultDir;
}

function tempDataDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'human-distiller-data-'));
}

function writeCurated(vaultDir: string, relPath: string, content: string): string {
  const filePath = path.join(vaultDir, 'curated', relPath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  return filePath;
}

test('golden path: explicit frontmatter note_id lands on the note log verbatim', () => {
  const vaultDir = tempVaultDir();
  const dataDir = tempDataDir();
  const body = '# Author context\n\nThe project favors KISS over cleverness.\n\nMore detail here.\n';
  const content = ['---', 'note_id: curated:author-context', 'project_slug: librarian', '---', body].join('\n');
  const filePath = writeCurated(vaultDir, 'author-context.md', content);

  const note = importCuratedNote(vaultDir, filePath, dataDir);

  assert.equal(note.note_id, 'curated:author-context');
  assert.equal(note.identity.mode, 'deterministic');
  assert.equal(note.identity.key, 'curated:author-context');
  assert.equal(note.note_type, 'curated');
  assert.equal(note.title, 'Author context');
  assert.equal(note.body.summary, 'The project favors KISS over cleverness.');
  assert.equal(note.body.details, body);
  assert.equal(note.source.origin, 'human');
  assert.equal(note.source.distiller, 'human');
  assert.equal(note.source.source_path, 'curated/author-context.md');
  assert.equal(
    note.source.content_hash,
    `sha256:${createHash('sha256').update(content).digest('hex')}`,
  );
  assert.deepEqual(note.scope, { project_slug: 'librarian' });
  assert.deepEqual(note.provenance, {});

  const stored = readAllNotes(dataDir) as Array<Record<string, unknown>>;
  assert.equal(stored.length, 1);
  assert.equal(stored[0].note_id, 'curated:author-context');
});

test('golden path: no frontmatter falls back to a path-hash note_id, stable across two runs', () => {
  const vaultDir = tempVaultDir();
  const dataDir = tempDataDir();
  const content = '# Untitled Notes\n\nFirst paragraph body.\n';
  const filePath = writeCurated(vaultDir, 'notes/no-frontmatter.md', content);

  const first = importCuratedNote(vaultDir, filePath, dataDir);
  const second = importCuratedNote(vaultDir, filePath, dataDir);

  assert.ok(first.note_id.startsWith('curated:'));
  assert.match(first.note_id.slice('curated:'.length), /^[0-9a-f]{64}$/);
  assert.equal(first.note_id, second.note_id);
  assert.deepEqual(first.scope, { global: true });
  assert.equal(first.title, 'Untitled Notes');
  assert.equal(first.body.summary, 'First paragraph body.');
  assert.equal(first.body.details, content);
});

test('rejection: a file under generated/ is refused', () => {
  const vaultDir = tempVaultDir();
  const dataDir = tempDataDir();
  const filePath = path.join(vaultDir, 'generated', 'decision', 'x.md');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, '# Exported\n\nsome body\n');

  assert.throws(() => importCuratedNote(vaultDir, filePath, dataDir), /not under.*curated/);
});

test('rejection: a librarian_generated file placed inside curated/ is refused', () => {
  const vaultDir = tempVaultDir();
  const dataDir = tempDataDir();
  const content = [
    '---',
    'librarian_generated: true',
    '---',
    '',
    '<!-- librarian:generated; do not edit -->',
    '',
    '# Exported into curated by mistake',
  ].join('\n');
  const filePath = writeCurated(vaultDir, 'sneaky.md', content);

  assert.throws(() => importCuratedNote(vaultDir, filePath, dataDir), /librarian_generated/);
});

test('rejection: a diagnostics record fed to the importer is refused', () => {
  const vaultDir = tempVaultDir();
  const dataDir = tempDataDir();
  const diagnostic = JSON.stringify({
    record_class: 'diagnostic',
    injection_id: '01J8X9F1TZ6R3M8N0P5Q7S9VWX',
    ts: '2026-07-05T10:00:00.000Z',
  });
  const filePath = writeCurated(vaultDir, 'trace.ndjson', diagnostic);

  assert.throws(() => importCuratedNote(vaultDir, filePath, dataDir), /record_class: diagnostic/);
});

test('rejection: non-.md files are refused even without a diagnostic marker', () => {
  const vaultDir = tempVaultDir();
  const dataDir = tempDataDir();
  const filePath = writeCurated(vaultDir, 'notes.txt', '# Plain text file\n\nbody\n');

  assert.throws(() => importCuratedNote(vaultDir, filePath, dataDir), /not a \.md file/);
});

test('rejection: a .md file with record_class: diagnostic in YAML frontmatter is refused', () => {
  const vaultDir = tempVaultDir();
  const dataDir = tempDataDir();
  const content = ['---', 'record_class: diagnostic', '---', '# Not a curated note'].join('\n');
  const filePath = writeCurated(vaultDir, 'poison.md', content);

  assert.throws(() => importCuratedNote(vaultDir, filePath, dataDir), /record_class: diagnostic/);
});

test('rejection: a symlink inside curated/ pointing outside the vault does not bypass the directory check', () => {
  const vaultDir = tempVaultDir();
  const dataDir = tempDataDir();
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'human-distiller-outside-'));
  const outsideFile = path.join(outsideDir, 'secret.md');
  fs.writeFileSync(outsideFile, '# Outside\n\nshould never be ingested\n');
  const symlinkPath = path.join(vaultDir, 'curated', 'escape.md');
  fs.symlinkSync(outsideFile, symlinkPath);

  assert.throws(() => importCuratedNote(vaultDir, symlinkPath, dataDir), /not under.*curated/);
});
