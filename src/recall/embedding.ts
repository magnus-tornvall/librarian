import type Database from 'better-sqlite3';
import { loadConfig } from '../config.ts';
import { assertEmbeddingIndexModel, setEmbeddingIndexModel } from '../index/database.ts';
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
