import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { embeddingCoverage, openIndexWrite } from '../../src/index/database.ts';
import { embedIndexedNotes, indexNotes } from '../../src/index/indexer.ts';
import { appendNote } from '../../src/log/noteLog.ts';
import type { EmbeddingProvider } from '../../src/embedding/provider.ts';

function dirs(): { dataDir: string; indexDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'index-embedding-'));
  return { dataDir: path.join(root, 'data'), indexDir: path.join(root, 'index') };
}

function note(noteId: string, revisionId: string): Record<string, unknown> {
  return {
    kind: 'note_revision', schema_version: 1, note_id: noteId, revision_id: revisionId,
    created_at: '2026-07-18T10:00:00.000Z', identity: { mode: 'episodic' },
    source: { origin: 'opencode', distiller: 'llm' }, note_type: 'fact', title: noteId,
    scope: { project_slug: 'alpha' }, provenance: {}, links: [], body: { summary: `${noteId} searchable memory` },
  };
}

const model = { name: 'fixture', digest: 'sha256:fixture' };
const provider = (embed: (input: string) => Promise<number[]>): EmbeddingProvider => ({
  async model() { return model; },
  embed,
});

test('index-time embeddings are queryable, retry failed rows, and remove vectors with invalidated notes', async () => {
  const { dataDir, indexDir } = dirs();
  appendNote(dataDir, note('fact:one', 'one'));
  appendNote(dataDir, note('fact:two', 'two'));
  const db = openIndexWrite(indexDir);
  try {
    indexNotes(db, dataDir);
    await embedIndexedNotes(db, provider(async (input) => input.includes('one') ? [1, 0] : [0, 1]), model);
    assert.deepEqual(embeddingCoverage(db), { embedded: 2, total: 2, state: 'complete' });
    assert.deepEqual(
      db.prepare('SELECT note_id FROM note_vectors WHERE embedding MATCH ? AND k = 1').all(JSON.stringify([1, 0])),
      [{ note_id: 'fact:one' }],
    );

    appendNote(dataDir, { kind: 'note_tombstone', schema_version: 1, note_id: 'fact:one', revision_id: 'dead', previous_revision_id: 'one', created_at: '2026-07-18T11:00:00.000Z', source: { kind: 'cli' } });
    indexNotes(db, dataDir);
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM note_vectors WHERE note_id = ?').get('fact:one') as { count: number }).count, 0);

    appendNote(dataDir, { kind: 'note_supersession', schema_version: 1, note_id: 'fact:two', superseded_by: 'fact:replacement', revision_id: 'superseded', created_at: '2026-07-18T11:00:00.000Z', source: { kind: 'cli' } });
    indexNotes(db, dataDir);
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM note_vectors').get() as { count: number }).count, 0);
  } finally {
    db.close();
  }
});

test('a provider failure leaves FTS indexed and retries missing vectors on the next pass', async () => {
  const { dataDir, indexDir } = dirs();
  appendNote(dataDir, note('fact:retry', 'retry'));
  const db = openIndexWrite(indexDir);
  try {
    indexNotes(db, dataDir);
    await embedIndexedNotes(db, provider(async () => { throw new Error('provider down'); }), model);
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM notes_fts').get() as { count: number }).count, 1);
    assert.deepEqual(embeddingCoverage(db), { embedded: 0, total: 1, state: 'partial' });

    await embedIndexedNotes(db, provider(async () => [0.5, 0.5]), model);
    assert.deepEqual(embeddingCoverage(db), { embedded: 1, total: 1, state: 'complete' });
  } finally {
    db.close();
  }
});

function runCli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const cli = path.join(import.meta.dirname, '..', '..', 'src', 'cli.ts');
  const child = spawn(process.execPath, [cli, ...args]);
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  return new Promise((resolve) => child.on('close', (code) => resolve({ code, stdout, stderr })));
}

test('drain with a fake provider reports full embedding coverage in stats', async () => {
  const { dataDir, indexDir } = dirs();
  const vaultDir = path.join(path.dirname(dataDir), 'vault');
  const configPath = path.join(path.dirname(dataDir), 'config.json');
  appendNote(dataDir, note('fact:smoke', 'smoke'));
  const server = http.createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/api/tags') response.end(JSON.stringify({ models: [{ name: model.name, digest: model.digest }] }));
    else if (request.url === '/v1/embeddings') response.end(JSON.stringify({ data: [{ embedding: [0.25, 0.75] }] }));
    else response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  fs.writeFileSync(configPath, JSON.stringify({ embedding: { endpoint: `http://127.0.0.1:${address.port}`, model: model.name, timeoutMs: 100 } }));
  try {
    const drain = await runCli(['drain', '--data-dir', dataDir, '--index-dir', indexDir, '--vault', vaultDir, '--config', configPath]);
    assert.equal(drain.code, 0, drain.stderr);
    const stats = await runCli(['stats', '--json', '--data-dir', dataDir, '--index-dir', indexDir]);
    assert.equal(stats.code, 0, stats.stderr);
    assert.deepEqual(JSON.parse(stats.stdout).index.embedding, { embedded: 1, total: 1, state: 'complete' });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('no embedding configuration leaves the index operational with disabled zero coverage', () => {
  const { dataDir, indexDir } = dirs();
  appendNote(dataDir, note('fact:bm25', 'bm25'));
  const db = openIndexWrite(indexDir);
  try {
    indexNotes(db, dataDir);
    assert.deepEqual(embeddingCoverage(db), { embedded: 0, total: 1, state: 'disabled' });
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM notes_fts').get() as { count: number }).count, 1);
  } finally {
    db.close();
  }
  const cli = path.join(import.meta.dirname, '..', '..', 'src', 'cli.ts');
  const result = spawnSync('node', [cli, 'stats', '--json', '--data-dir', dataDir, '--index-dir', indexDir], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).index.embedding, { embedded: 0, total: 1, state: 'disabled' });
});
