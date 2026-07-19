import type Database from 'better-sqlite3';
import { loadConfig } from '../config.ts';
import { assertEmbeddingIndexModel, openIndexWrite, setEmbeddingIndexModel } from '../index/database.ts';
import { embedIndexedNotes, indexNotes, isSystemicIndexError, SystemicIndexError } from '../index/indexer.ts';
import { classifyEmbeddingError, makeOpenAiEmbeddingProvider, type EmbeddingModel } from '../embedding/provider.ts';

export type QueryEmbedding = {
  status: 'ok' | 'timeout' | 'error' | 'disabled';
  model?: EmbeddingModel;
  vector?: number[];
};

export function isEmbeddingModelMismatch(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('embedding model changed from ');
}

export async function queryEmbedding(db: Database.Database, query: string, configPath?: string): Promise<QueryEmbedding> {
  const config = loadConfig(configPath);
  if (!config.embedding || query.length === 0) return { status: 'disabled' };
  const provider = makeOpenAiEmbeddingProvider(config.embedding);
  try {
    const [model, vector] = await Promise.all([provider.model(), provider.embed(query)]);
    assertEmbeddingIndexModel(db, model);
    return { status: 'ok', model, vector };
  } catch (error) {
    if (isEmbeddingModelMismatch(error)) throw error;
    return { status: classifyEmbeddingError(error) };
  }
}

export async function stampEmbeddingIndex(db: Database.Database, configPath?: string): Promise<QueryEmbedding['status']> {
  const config = loadConfig(configPath);
  if (!config.embedding) return 'disabled';
  const model = await makeOpenAiEmbeddingProvider(config.embedding).model();
  assertEmbeddingIndexModel(db, model);
  setEmbeddingIndexModel(db, model);
  return 'ok';
}

/**
 * Index-time embeddings are fail-soft: an unavailable provider leaves FTS recall
 * intact. Returns per-pass counts; systemic errors (model/dimension/empty/ABI)
 * propagate so the caller can fail loud (#137). An unreachable provider (a failed
 * `model()` fetch) still propagates as a plain error — recoverable, so the caller
 * downgrades it to a warning rather than aborting.
 */
export async function embedIndex(db: Database.Database, configPath?: string): Promise<{ embedded: number; failed: number }> {
  const config = loadConfig(configPath);
  if (!config.embedding) return { embedded: 0, failed: 0 };
  const provider = makeOpenAiEmbeddingProvider(config.embedding);
  return embedIndexedNotes(db, provider, await provider.model());
}

/**
 * Reconcile the index with the note log: replay pending records, embed new rows.
 * Intrinsic systemic failures (wrong-Node ABI, a model/dimension change, an empty
 * vector) always abort loudly. A genuinely recoverable stale index — the provider
 * is momentarily down, or the index write hit a transient snag — degrades to a
 * stderr warning, because the note log is already durable (#137).
 *
 * `failLoudOnTotalFailure` adds the batch proxy: when *every* pending row fails,
 * that is a near-free signal of a systemic outage/misconfiguration, so the batch
 * reconcile (drain/distill) aborts. The single-record CLI mutations leave it off
 * — a one-off transient failure on their lone row must not turn a durable append
 * into a hard error; the note still prints and the next drain retries the embed.
 */
export async function updateIndex(
  indexDir: string | undefined,
  dataDir: string,
  configPath?: string,
  { failLoudOnTotalFailure = false }: { failLoudOnTotalFailure?: boolean } = {},
): Promise<void> {
  try {
    const db = openIndexWrite(indexDir);
    try {
      indexNotes(db, dataDir);
      const { embedded, failed } = await embedIndex(db, configPath);
      if (failLoudOnTotalFailure && failed > 0 && embedded === 0) {
        throw new SystemicIndexError(`embedding failed for all ${failed} note(s); the provider is unreachable or misconfigured`);
      }
      if (failed > 0) {
        process.stderr.write(`librarian: ${failed} of ${embedded + failed} note(s) failed to embed; retrying on the next pass\n`);
      }
    } finally {
      db.close();
    }
  } catch (error) {
    if (isSystemicIndexError(error)) throw error;
    process.stderr.write(`librarian: note is durable but the index is stale; run librarian drain: ${(error as Error).message}\n`);
  }
}
