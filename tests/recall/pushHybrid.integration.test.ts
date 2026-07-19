import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { openIndexWrite } from '../../src/index/database.ts';
import { embedIndexedNotes, indexNotes } from '../../src/index/indexer.ts';
import { appendNote } from '../../src/log/noteLog.ts';
import { buildInjection } from '../../src/recall/inject.ts';
import type { EmbeddingProvider, EmbeddingModel } from '../../src/embedding/provider.ts';
import type { InjectionTrace } from '../../src/diagnostics/injectionTrace.ts';
import { readAll } from '../../src/log/ndjson.ts';

/**
 * Push-path hybrid (issue #105, spec §6 item 14.4): the invisible injection path
 * now feeds the query embedding into the same BM25+KNN→RRF recall the pull path
 * uses. Black-box through the REAL note-log → index → embed → buildInjection path.
 *
 * The index is embedded with a canned-vector fake provider; the QUERY vector is
 * served by a stdlib HTTP embedding endpoint the config points at (digest set so
 * the provider skips /api/tags). Killing that endpoint mid-flight is how fail-soft
 * (embedding down → BM25-only, contract intact) is exercised end to end.
 */

const MODEL: EmbeddingModel = { name: 'fixture-embed', digest: 'sha256:push-v1' };
const NOW = '2026-07-18T12:00:00.000Z';

function dirs(): { dataDir: string; indexDir: string; diagnosticsDir: string; root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'push-hybrid-'));
  return { root, dataDir: path.join(root, 'data'), indexDir: path.join(root, 'index'), diagnosticsDir: path.join(root, 'diagnostics') };
}

function note(noteId: string, title: string, summary: string): Record<string, unknown> {
  return {
    kind: 'note_revision', schema_version: 1, note_id: noteId, revision_id: `${noteId}-r1`,
    created_at: NOW, identity: { mode: 'episodic' }, source: { origin: 'opencode', distiller: 'llm' },
    note_type: 'fact', title, scope: { project_slug: 'alpha' }, provenance: {}, links: [],
    body: { summary },
  };
}

function indexProvider(vectorFor: (text: string) => number[]): EmbeddingProvider {
  return { async model() { return MODEL; }, async embed(input) { return vectorFor(input); } };
}

/** Seed the note log, index it, and embed every note with the fake index provider. */
async function seed(
  notes: Array<{ id: string; title: string; summary: string }>,
  vectorFor: (text: string) => number[],
): Promise<{ dataDir: string; indexDir: string; diagnosticsDir: string; root: string }> {
  const d = dirs();
  for (const n of notes) appendNote(d.dataDir, note(n.id, n.title, n.summary));
  const db = openIndexWrite(d.indexDir);
  try {
    indexNotes(db, d.dataDir);
    await embedIndexedNotes(db, indexProvider(vectorFor), MODEL, NOW); // stamps the model digest for query-time assert
  } finally {
    db.close();
  }
  return d;
}

/** A canned OpenAI-shaped embedding endpoint returning a fixed query vector. */
async function embeddingServer(queryVector: number[]): Promise<{ endpoint: string; close: () => Promise<void> }> {
  const server = http.createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/v1/embeddings') response.end(JSON.stringify({ data: [{ embedding: queryVector }] }));
    else response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

function writeConfig(root: string, endpoint: string): string {
  const configPath = path.join(root, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ embedding: { endpoint, model: MODEL.name, digest: MODEL.digest, timeoutMs: 400 } }));
  return configPath;
}

function readTraces(diagnosticsDir: string): InjectionTrace[] {
  const injectionsDir = path.join(diagnosticsDir, 'injections');
  if (!fs.existsSync(injectionsDir)) return [];
  return fs.readdirSync(injectionsDir)
    .filter((name) => name.endsWith('.ndjson'))
    .flatMap((name) => readAll(path.join(injectionsDir, name)) as InjectionTrace[]);
}

test('push injection surfaces an English note for a Swedish prompt via the KNN channel (cross-language)', async () => {
  // English note and Swedish prompt share NO lexical tokens: only the semantic
  // channel can bridge them — proving the push path is now hybrid, not BM25-only.
  const d = await seed(
    [
      { id: 'fact:deploy-en', title: 'Deployment', summary: 'the service deploys to production every friday' },
      { id: 'fact:cats', title: 'Cats', summary: 'the office cat sleeps on the keyboard' },
    ],
    (text) => (text.includes('deploys to production') ? [1, 0] : [0, 1]),
  );
  const server = await embeddingServer([1, 0]); // Swedish prompt ≈ the English deploy note
  const configPath = writeConfig(d.root, server.endpoint);
  try {
    const block = await buildInjection({
      dataDir: d.dataDir, diagnosticsDir: d.diagnosticsDir, indexDir: d.indexDir, configPath,
      query: 'utplacering till produktion', projectSlug: 'alpha', global: false, sessionStart: false,
    });
    assert.ok(block, 'a cross-language hit must produce an injection block');
    assert.match(block, /fact:deploy-en/, 'the English note is surfaced by the KNN channel');
    assert.doesNotMatch(block, /fact:cats/, 'the orthogonal distractor is not resurrected');
    const trace = readTraces(d.diagnosticsDir).at(-1);
    assert.equal(trace?.embedding, 'ok', 'the trace records a successful query embedding');
    assert.deepEqual(trace?.shipped_note_ids, ['fact:deploy-en']);
  } finally {
    await server.close();
  }
});

test('push injection fails soft: embedding endpoint down → BM25-only block within contract, trace records the degradation', async () => {
  const d = await seed(
    [
      { id: 'fact:bm', title: 'Backups', summary: 'nightly backups run at 2am for the alpha service database' },
      { id: 'fact:fw', title: 'Firewall', summary: 'the firewall blocks inbound traffic on port 8080' },
      { id: 'fact:deploy-en', title: 'Deployment', summary: 'the service deploys to production every friday' },
    ],
    (text) => (text.includes('deploys to production') ? [1, 0] : [0, 1]),
  );
  // Stand the endpoint up, then kill it BEFORE injection: the query embed fails,
  // recall degrades to BM25-only, the floor holds, and the block still ships.
  const server = await embeddingServer([1, 0]);
  const configPath = writeConfig(d.root, server.endpoint);
  await server.close();
  const block = await buildInjection({
    dataDir: d.dataDir, diagnosticsDir: d.diagnosticsDir, indexDir: d.indexDir, configPath,
    query: 'nightly backups', projectSlug: 'alpha', global: false, sessionStart: false,
  });
  assert.ok(block, 'the lexical hit still ships on the BM25-only fallback');
  assert.match(block, /fact:bm/, 'BM25 surfaces the lexical match without any query vector');
  const trace = readTraces(d.diagnosticsDir).at(-1);
  assert.ok(trace?.embedding === 'error' || trace?.embedding === 'timeout', `endpoint-down degradation is recorded, got ${String(trace?.embedding)}`);
  assert.deepEqual(trace?.shipped_note_ids, ['fact:bm'], 'the block ships exactly the BM25 hit — austerity contract intact');
});
