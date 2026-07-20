import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { makeFixtureEmbeddingProvider, makeOpenAiEmbeddingProvider } from '../../src/embedding/provider.ts';
import { loadConfig } from '../../src/config.ts';
import { appendNote } from '../../src/log/noteLog.ts';
import { readInjectionTraces } from '../../src/diagnostics/injectionTrace.ts';
import { embeddingIndexModel, openIndexWrite, setEmbeddingIndexModel } from '../../src/index/database.ts';
import { indexNotes } from '../../src/index/indexer.ts';
import { doctorReport, runRecall, type RecallOptions } from '../../src/cli.ts';
import { stampEmbeddingIndex } from '../../src/recall/embedding.ts';
import type { NoteRevision } from '../../src/note.ts';

function root(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'embedding-provider-')); }

function config(file: string, endpoint: string, timeoutMs = 100, digest?: string): void {
  fs.writeFileSync(file, JSON.stringify({ embedding: { endpoint, model: 'qwen3-embedding:0.6b', timeoutMs, ...(digest ? { digest } : {}) } }));
}

function note(): NoteRevision {
  return {
    kind: 'note_revision', schema_version: 1, note_id: 'fact:embedding', revision_id: 'embedding-rev',
    created_at: '2026-07-18T10:00:00.000Z', identity: { mode: 'episodic' }, source: { origin: 'opencode', distiller: 'llm' },
    note_type: 'decision', title: 'Embedding provider seam', scope: { project_slug: 'alpha' }, provenance: {}, links: [],
    body: { summary: 'BM25 remains available when the embedding endpoint fails.' },
  };
}

function index(dataDir: string, indexDir: string): void {
  const db = openIndexWrite(indexDir);
  try { indexNotes(db, dataDir); } finally { db.close(); }
}

async function fakeEndpoint(): Promise<{ endpoint: string; setMode(mode: 'ok' | 'error' | 'timeout' | 'slow-embed'): void; close(): Promise<void> }> {
  let mode: 'ok' | 'error' | 'timeout' | 'slow-embed' = 'ok';
  const server = http.createServer((request, response) => {
    if (mode === 'timeout') return;
    if (mode === 'error') { response.writeHead(500).end('down'); return; }
    if (request.url === '/api/tags') { response.setHeader('content-type', 'application/json').end(JSON.stringify({ models: [{ name: 'qwen3-embedding:0.6b', digest: 'sha256:fixture' }] })); return; }
    if (request.url === '/v1/embeddings') {
      const send = () => response.setHeader('content-type', 'application/json').end(JSON.stringify({ data: [{ embedding: [0.25, 0.75] }] }));
      if (mode === 'slow-embed') { setTimeout(send, 100); return; }
      send();
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    setMode(next) { mode = next; },
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

test('fixture provider is a normal provider seam', async () => {
  const provider = makeFixtureEmbeddingProvider({ name: 'fixture', digest: 'sha256:fixture' }, [1, 2]);
  assert.deepEqual(await provider.model(), { name: 'fixture', digest: 'sha256:fixture' });
  assert.deepEqual(await provider.embed('Swedish query'), [1, 2]);
});

test('an OpenAI-compatible endpoint needs no Ollama metadata endpoint when digest is configured', async () => {
  const server = http.createServer((request, response) => {
    assert.equal(request.url, '/v1/embeddings');
    response.setHeader('content-type', 'application/json').end(JSON.stringify({ data: [{ embedding: [1, 2] }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try {
    const provider = makeOpenAiEmbeddingProvider({ endpoint: `http://127.0.0.1:${address.port}`, model: 'remote-model', digest: 'deployment-revision', timeoutMs: 100 });
    assert.deepEqual(await provider.model(), { name: 'remote-model', digest: 'deployment-revision' });
    assert.deepEqual(await provider.embed('query'), [1, 2]);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('real Ollama endpoint returns a digest and vector when explicitly enabled', { skip: process.env.LIBRARIAN_TEST_OLLAMA !== '1' }, async () => {
  const embedding = loadConfig().embedding;
  assert.ok(embedding, 'configure embedding in ~/.librarian/config.json before enabling this test');
  const provider = makeOpenAiEmbeddingProvider(embedding);
  assert.equal((await provider.model()).name, embedding.model);
  assert.ok((await provider.embed('smoke')).length > 0);
});

test('recall is BM25-only when disabled or endpoint fails, and traces the embedding state', async () => {
  const temp = root();
  const dataDir = path.join(temp, 'data');
  const indexDir = path.join(temp, 'index');
  const diagnosticsDir = path.join(temp, 'diagnostics');
  const configPath = path.join(temp, 'config.json');
  appendNote(dataDir, note());
  for (let i = 0; i < 20; i += 1) appendNote(dataDir, { ...note(), note_id: `fact:decoy-${i}`, revision_id: `decoy-${i}`, title: `Irrelevant decoy ${i}`, body: { summary: `irrelevant filler ${i}` } });
  index(dataDir, indexDir);
  const options: RecallOptions = { query: 'embedding provider', projectSlug: 'alpha', global: false, limit: 10, json: true, dataDir, indexDir, diagnosticsDir, configPath };

  const disabled = await runRecall(options);
  assert.deepEqual(disabled.results.map((row) => row.note_id), ['fact:embedding']);
  assert.equal(readInjectionTraces(diagnosticsDir).at(-1)?.embedding, 'disabled');

  const endpoint = await fakeEndpoint();
  try {
    config(configPath, endpoint.endpoint);
    const healthy = await runRecall(options);
    assert.deepEqual(healthy.results.map((row) => row.note_id), ['fact:embedding']);
    assert.equal(readInjectionTraces(diagnosticsDir).at(-1)?.embedding, 'ok');
    endpoint.setMode('error');
    const errored = await runRecall(options);
    assert.deepEqual(errored.results.map((row) => row.note_id), ['fact:embedding']);
    assert.equal(readInjectionTraces(diagnosticsDir).at(-1)?.embedding, 'error');
    endpoint.setMode('timeout');
    config(configPath, endpoint.endpoint, 10);
    const timedOut = await runRecall(options);
    assert.deepEqual(timedOut.results.map((row) => row.note_id), ['fact:embedding']);
    assert.equal(readInjectionTraces(diagnosticsDir).at(-1)?.embedding, 'timeout');
  } finally {
    await endpoint.close();
  }
});

test('doctor probes a real embed: reports dims + latency when ok, timeout when the embed exceeds timeoutMs', async () => {
  const temp = root();
  const dataDir = path.join(temp, 'data');
  const indexDir = path.join(temp, 'index');
  const configPath = path.join(temp, 'config.json');
  appendNote(dataDir, note());
  index(dataDir, indexDir);

  const endpoint = await fakeEndpoint();
  try {
    // Digest pinned so model() makes no call — the probe alone exercises the embed path.
    config(configPath, endpoint.endpoint, 2000, 'sha256:fixture');
    const db = openIndexWrite(indexDir);
    try { setEmbeddingIndexModel(db, { name: 'qwen3-embedding:0.6b', digest: 'sha256:fixture' }); } finally { db.close(); }

    const ok = await doctorReport(indexDir, configPath);
    assert.equal(ok.embedding.state, 'ok');
    assert.equal(ok.embedding.dims, 2);
    assert.equal(typeof ok.embedding.latency_ms, 'number');

    // Real embed latency (~100ms) exceeds a 10ms timeout → timeout, not ok. Regression for #138.
    endpoint.setMode('slow-embed');
    config(configPath, endpoint.endpoint, 10, 'sha256:fixture');
    const timedOut = await doctorReport(indexDir, configPath);
    assert.equal(timedOut.embedding.state, 'timeout');
  } finally {
    await endpoint.close();
  }
});

test('digest mismatch refuses recall and doctor reports every readiness state', async () => {
  const temp = root();
  const dataDir = path.join(temp, 'data');
  const indexDir = path.join(temp, 'index');
  const configPath = path.join(temp, 'config.json');
  appendNote(dataDir, note());
  index(dataDir, indexDir);
  assert.equal((await doctorReport(indexDir, configPath)).embedding.state, 'unconfigured');
  config(configPath, 'http://127.0.0.1:1', 10);
  assert.equal((await doctorReport(indexDir, configPath)).embedding.state, 'unreachable');

  const endpoint = await fakeEndpoint();
  try {
    config(configPath, endpoint.endpoint);
    const missingIndex = await doctorReport(path.join(temp, 'missing-index'), configPath);
    assert.equal(missingIndex.embedding.state, 'unpinned');
    assert.match(missingIndex.index_error ?? '', /recall index is missing/);
    assert.equal((await doctorReport(indexDir, configPath)).embedding.state, 'unpinned');
    const db = openIndexWrite(indexDir);
    try {
      assert.equal(await stampEmbeddingIndex(db, configPath), 'ok');
      assert.deepEqual(embeddingIndexModel(db), { name: 'qwen3-embedding:0.6b', digest: 'sha256:fixture' });
      setEmbeddingIndexModel(db, { name: 'qwen3-embedding:0.6b', digest: 'sha256:old' });
    } finally { db.close(); }
    const mismatch = await doctorReport(indexDir, configPath);
    assert.equal(mismatch.embedding.state, 'mismatch');
    assert.equal(mismatch.embedding.index_digest, 'sha256:old');
    await assert.rejects(
      runRecall({ query: 'embedding', projectSlug: 'alpha', global: false, limit: 10, json: true, dataDir, indexDir, diagnosticsDir: path.join(temp, 'diagnostics'), configPath }),
      /delete the index directory and run librarian drain/,
    );
    const write = openIndexWrite(indexDir);
    try { setEmbeddingIndexModel(write, { name: 'qwen3-embedding:0.6b', digest: 'sha256:fixture' }); } finally { write.close(); }
    const ok = await doctorReport(indexDir, configPath);
    assert.equal(ok.embedding.state, 'ok');
    const read = openIndexWrite(indexDir);
    try { assert.deepEqual(embeddingIndexModel(read), { name: 'qwen3-embedding:0.6b', digest: 'sha256:fixture' }); } finally { read.close(); }
  } finally {
    await endpoint.close();
  }
});
