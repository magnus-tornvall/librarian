import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { embeddingCoverage, openIndexWrite } from '../../src/index/database.ts';
import { embedIndexedNotes, indexNotes, isSystemicIndexError, SystemicIndexError } from '../../src/index/indexer.ts';
import { updateIndex } from '../../src/recall/embedding.ts';
import { appendNote } from '../../src/log/noteLog.ts';
import type { EmbeddingProvider } from '../../src/embedding/provider.ts';

// Integration coverage for #137: index/embed failures split into transient
// (warn, retry next pass) vs systemic (throw, non-zero exit). Exercised through
// each stage's real input/output contract with plain-file fixtures and, for the
// end-to-end drain, the real CLI against a local HTTP embedding endpoint.

function dirs(): { dataDir: string; indexDir: string; configPath: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'systemic-index-'));
  return { dataDir: path.join(root, 'data'), indexDir: path.join(root, 'index'), configPath: path.join(root, 'config.json') };
}

function note(noteId: string): Record<string, unknown> {
  return {
    kind: 'note_revision', schema_version: 1, note_id: noteId, revision_id: noteId,
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

/** A local OpenAI/Ollama-compatible endpoint whose /v1/embeddings always 500s;
 *  /api/tags still resolves the model so failure lands on the embed call, not model(). */
function embedAlways500(): http.Server {
  return http.createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/api/tags') response.end(JSON.stringify({ models: [{ name: model.name, digest: model.digest }] }));
    else response.writeHead(500).end(JSON.stringify({ error: 'embeddings unavailable' }));
  });
}

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return address.port;
}

function close(server: http.Server): Promise<void> {
  return new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

/** Bind then immediately release a port so a later connect reliably refuses. */
async function unusedPort(): Promise<number> {
  const server = http.createServer();
  const port = await listen(server);
  await close(server);
  return port;
}

test('embedIndexedNotes counts embedded vs failed rows and retries only the failures on the next pass', async () => {
  const { dataDir, indexDir } = dirs();
  appendNote(dataDir, note('fact:ok'));
  appendNote(dataDir, note('fact:bad'));
  const db = openIndexWrite(indexDir);
  try {
    indexNotes(db, dataDir);
    const first = await embedIndexedNotes(db, provider(async (input) => {
      if (input.includes('bad')) throw new Error('embedding endpoint returned HTTP 503');
      return [1, 0];
    }), model);
    assert.deepEqual(first, { embedded: 1, failed: 1 });
    assert.deepEqual(embeddingCoverage(db), { embedded: 1, total: 2, state: 'partial' });

    const second = await embedIndexedNotes(db, provider(async () => [0, 1]), model);
    assert.deepEqual(second, { embedded: 1, failed: 0 }, 'the next pass retries only the previously-failed row');
    assert.deepEqual(embeddingCoverage(db), { embedded: 2, total: 2, state: 'complete' });
  } finally {
    db.close();
  }
});

test('a changed vector dimension is systemic: it aborts the pass instead of retrying forever', async () => {
  const { dataDir, indexDir } = dirs();
  appendNote(dataDir, note('fact:dim'));
  const db = openIndexWrite(indexDir);
  try {
    indexNotes(db, dataDir);
    await embedIndexedNotes(db, provider(async () => [1, 0]), model); // creates the dim-2 vector table
    appendNote(dataDir, note('fact:dim2'));
    indexNotes(db, dataDir);
    await assert.rejects(
      embedIndexedNotes(db, provider(async () => [1, 0, 0]), model),
      /changed vector dimensions/,
    );
  } finally {
    db.close();
  }
});

test('an empty vector is systemic: it aborts the pass instead of being swallowed as a transient row', async () => {
  const { dataDir, indexDir } = dirs();
  appendNote(dataDir, note('fact:empty'));
  const db = openIndexWrite(indexDir);
  try {
    indexNotes(db, dataDir);
    await assert.rejects(
      embedIndexedNotes(db, provider(async () => []), model),
      /empty vector/,
    );
  } finally {
    db.close();
  }
});

test('isSystemicIndexError classifies unrecoverable failures loud and transient provider hiccups soft', () => {
  assert.equal(isSystemicIndexError(Object.assign(new Error('cannot open shared object'), { code: 'ERR_DLOPEN_FAILED' })), true, 'wrong-Node ABI is systemic');
  assert.equal(isSystemicIndexError(new SystemicIndexError('every row failed')), true);
  assert.equal(isSystemicIndexError(new Error('embedding model changed from a@1 to b@2; delete the index directory')), true);
  assert.equal(isSystemicIndexError(new Error('embedding provider changed vector dimensions from 2 to 3')), true);
  assert.equal(isSystemicIndexError(new Error('embedding provider returned an empty vector')), true);
  assert.equal(isSystemicIndexError(new Error('embedding endpoint returned HTTP 503')), false, 'a single bad response is transient');
  assert.equal(isSystemicIndexError(new Error('fetch failed')), false, 'a connect error is transient at the row level');
  assert.equal(isSystemicIndexError(undefined), false);
});

test('updateIndex fails loud (SystemicIndexError) when every embedding fails, leaving vectors unchanged', async () => {
  const { dataDir, indexDir, configPath } = dirs();
  appendNote(dataDir, note('fact:allfail'));
  const server = embedAlways500();
  const port = await listen(server);
  fs.writeFileSync(configPath, JSON.stringify({ embedding: { endpoint: `http://127.0.0.1:${port}`, model: model.name, timeoutMs: 500 } }));
  try {
    await assert.rejects(updateIndex(indexDir, dataDir, configPath), (error: unknown) => {
      assert.ok(error instanceof SystemicIndexError, `expected SystemicIndexError, got ${String(error)}`);
      assert.match((error as Error).message, /all 1 note/);
      return true;
    });
    const db = openIndexWrite(indexDir);
    try {
      assert.equal((db.prepare('SELECT COUNT(*) AS count FROM notes_fts').get() as { count: number }).count, 1, 'FTS recall stays intact');
      assert.deepEqual(embeddingCoverage(db, true), { embedded: 0, total: 1, state: 'partial' }, 'no vectors were written');
    } finally {
      db.close();
    }
  } finally {
    await close(server);
  }
});

test('updateIndex stays fail-soft when the provider is unreachable: note durable, index stale, no crash', async () => {
  const { dataDir, indexDir, configPath } = dirs();
  appendNote(dataDir, note('fact:down'));
  const port = await unusedPort();
  fs.writeFileSync(configPath, JSON.stringify({ embedding: { endpoint: `http://127.0.0.1:${port}`, model: model.name, timeoutMs: 300 } }));
  const warnings: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  (process.stderr as unknown as { write: (chunk: unknown) => boolean }).write = (chunk) => { warnings.push(String(chunk)); return true; };
  try {
    await updateIndex(indexDir, dataDir, configPath); // must NOT throw — an unreachable provider is recoverable
  } finally {
    (process.stderr as unknown as { write: typeof original }).write = original;
  }
  assert.ok(warnings.some((w) => /index is stale/.test(w)), `expected a stale-index warning, got: ${warnings.join('')}`);
  const db = openIndexWrite(indexDir);
  try {
    assert.deepEqual(embeddingCoverage(db, true), { embedded: 0, total: 1, state: 'partial' });
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

test('drain exits non-zero and names the cause when the embedding provider fails every row', async () => {
  const { dataDir, indexDir, configPath } = dirs();
  appendNote(dataDir, note('fact:drainfail'));
  const server = embedAlways500();
  const port = await listen(server);
  fs.writeFileSync(configPath, JSON.stringify({ embedding: { endpoint: `http://127.0.0.1:${port}`, model: model.name, timeoutMs: 500 } }));
  try {
    const drain = await runCli(['drain', '--data-dir', dataDir, '--index-dir', indexDir, '--config', configPath]);
    assert.notEqual(drain.code, 0, `a wholly-failed embed batch must abort drain; stdout: ${drain.stdout}`);
    assert.match(drain.stderr, /embedding failed for all/);
  } finally {
    await close(server);
  }
});
