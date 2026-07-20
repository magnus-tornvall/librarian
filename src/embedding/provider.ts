import type { LibrarianConfig } from '../config.ts';

export type EmbeddingModel = { name: string; digest: string };
export type EmbeddingProvider = {
  model(): Promise<EmbeddingModel>;
  embed(input: string): Promise<number[]>;
};

export class EmbeddingTimeoutError extends Error {
  constructor() {
    super('embedding request timed out');
  }
}

function endpointUrl(endpoint: string, suffix: string): string {
  return `${endpoint.replace(/\/$/, '')}${suffix}`;
}

async function request(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  try {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new Error(`embedding endpoint returned HTTP ${response.status}`);
    return response;
  } catch (error) {
    if (error instanceof DOMException && error.name === 'TimeoutError') throw new EmbeddingTimeoutError();
    throw error;
  }
}

/**
 * OpenAI-compatible vectors plus Ollama's digest endpoint for reproducible local models.
 * `timeoutMs` overrides the config's index/background budget — the recall path passes its
 * tighter `recallTimeoutMs` so a slow embed degrades recall instead of hanging it (#139).
 */
export function makeOpenAiEmbeddingProvider(config: NonNullable<LibrarianConfig['embedding']>, timeoutMs = config.timeoutMs): EmbeddingProvider {
  return {
    async model(): Promise<EmbeddingModel> {
      if (config.digest) return { name: config.model, digest: config.digest };
      const response = await request(endpointUrl(config.endpoint, '/api/tags'), { method: 'GET' }, timeoutMs);
      const body = await response.json() as { models?: Array<{ name?: unknown; digest?: unknown }> };
      const digest = body.models?.find((model) => model.name === config.model)?.digest;
      if (typeof digest !== 'string' || digest.length === 0) {
        throw new Error(`embedding endpoint did not return a digest for ${config.model}`);
      }
      return { name: config.model, digest };
    },
    async embed(input: string): Promise<number[]> {
      const response = await request(endpointUrl(config.endpoint, '/v1/embeddings'), {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: config.model, input }),
      }, timeoutMs);
      const body = await response.json() as { data?: Array<{ embedding?: unknown }> };
      const vector = body.data?.[0]?.embedding;
      if (!Array.isArray(vector) || !vector.every((value) => typeof value === 'number' && Number.isFinite(value))) {
        throw new Error('embedding endpoint returned an invalid vector');
      }
      return vector;
    },
  };
}

export function makeFixtureEmbeddingProvider(model: EmbeddingModel, vector: number[]): EmbeddingProvider {
  return {
    async model(): Promise<EmbeddingModel> { return model; },
    async embed(): Promise<number[]> { return vector; },
  };
}

export function classifyEmbeddingError(error: unknown): 'timeout' | 'error' {
  return error instanceof EmbeddingTimeoutError || (error instanceof DOMException && error.name === 'TimeoutError') ? 'timeout' : 'error';
}
