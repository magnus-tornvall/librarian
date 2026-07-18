import type Database from 'better-sqlite3';
import { loadConfig } from '../config.ts';
import { assertEmbeddingIndexModel, setEmbeddingIndexModel } from '../index/database.ts';
import { classifyEmbeddingError, makeOpenAiEmbeddingProvider, type EmbeddingModel } from '../embedding/provider.ts';

export type QueryEmbedding = {
  status: 'ok' | 'timeout' | 'error' | 'disabled';
  model?: EmbeddingModel;
  vector?: number[];
};

export async function queryEmbedding(db: Database.Database, query: string, configPath?: string): Promise<QueryEmbedding> {
  const config = loadConfig(configPath);
  if (!config.embedding || query.length === 0) return { status: 'disabled' };
  const provider = makeOpenAiEmbeddingProvider(config.embedding);
  try {
    const [model, vector] = await Promise.all([provider.model(), provider.embed(query)]);
    assertEmbeddingIndexModel(db, model);
    return { status: 'ok', model, vector };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('embedding model changed from ')) throw error;
    return { status: classifyEmbeddingError(error) };
  }
}

export async function stampEmbeddingIndex(db: Database.Database, configPath?: string): Promise<QueryEmbedding['status']> {
  const config = loadConfig(configPath);
  if (!config.embedding) return 'disabled';
  try {
    const model = await makeOpenAiEmbeddingProvider(config.embedding).model();
    assertEmbeddingIndexModel(db, model);
    setEmbeddingIndexModel(db, model);
    return 'ok';
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('embedding model changed from ')) throw error;
    return classifyEmbeddingError(error);
  }
}
