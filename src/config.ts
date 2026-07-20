import fs from 'node:fs';
import { CONFIG_PATH } from './paths.ts';
import { DEFAULT_SCORING_CONFIG, type ScoringConfig } from './recall/scoring.ts';

export type LibrarianConfig = {
  inference: {
    provider: 'claude' | 'opencode';
    model?: string;
  };
  embedding?: {
    endpoint: string;
    model: string;
    digest?: string;
    timeoutMs: number;
    recallTimeoutMs: number;
  };
  scoring: ScoringConfig;
};

function invalid(key: string, configPath: string, expected: string): never {
  throw new Error(`invalid ${key} in ${configPath}: expected ${expected}`);
}

function numberValue(value: unknown, key: string, configPath: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    invalid(key, configPath, 'a finite number');
  }
  return value;
}

function numberRecord(value: unknown, key: string, configPath: string, infinity = false): Record<string, number> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    invalid(key, configPath, 'an object of numbers');
  }
  return Object.fromEntries(Object.entries(value).map(([name, item]) => [
    name,
    infinity && item === 'Infinity' ? Infinity : numberValue(item, `${key}.${name}`, configPath),
  ]));
}

function scoringConfig(value: unknown, configPath: string): ScoringConfig {
  if (value === undefined) {
    return {
      ...DEFAULT_SCORING_CONFIG,
      originWeights: { ...DEFAULT_SCORING_CONFIG.originWeights },
      typeWeights: { ...DEFAULT_SCORING_CONFIG.typeWeights },
      recencyHalfLifeDays: { ...DEFAULT_SCORING_CONFIG.recencyHalfLifeDays },
      ttlDays: { ...DEFAULT_SCORING_CONFIG.ttlDays },
    };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    invalid('scoring', configPath, 'an object');
  }
  const scoring = value as Record<string, unknown>;
  return {
    originWeights: { ...DEFAULT_SCORING_CONFIG.originWeights, ...(scoring.originWeights === undefined ? {} : numberRecord(scoring.originWeights, 'scoring.originWeights', configPath)) },
    typeWeights: { ...DEFAULT_SCORING_CONFIG.typeWeights, ...(scoring.typeWeights === undefined ? {} : numberRecord(scoring.typeWeights, 'scoring.typeWeights', configPath)) },
    relevanceFloor: scoring.relevanceFloor === undefined ? DEFAULT_SCORING_CONFIG.relevanceFloor : numberValue(scoring.relevanceFloor, 'scoring.relevanceFloor', configPath),
    recencyHalfLifeDays: { ...DEFAULT_SCORING_CONFIG.recencyHalfLifeDays, ...(scoring.recencyHalfLifeDays === undefined ? {} : numberRecord(scoring.recencyHalfLifeDays, 'scoring.recencyHalfLifeDays', configPath, true)) },
    ttlDays: { ...DEFAULT_SCORING_CONFIG.ttlDays, ...(scoring.ttlDays === undefined ? {} : numberRecord(scoring.ttlDays, 'scoring.ttlDays', configPath, true)) },
    projectBoost: scoring.projectBoost === undefined ? DEFAULT_SCORING_CONFIG.projectBoost : numberValue(scoring.projectBoost, 'scoring.projectBoost', configPath),
  };
}

function positiveTimeout(value: unknown, fallback: number, key: string, configPath: string): number {
  const timeout = value ?? fallback;
  if (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout <= 0) {
    invalid(key, configPath, 'a positive finite number');
  }
  return timeout;
}

function embeddingConfig(value: unknown, configPath: string): LibrarianConfig['embedding'] {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    invalid('embedding', configPath, 'an object');
  }
  const embedding = value as Record<string, unknown>;
  if (typeof embedding.endpoint !== 'string' || embedding.endpoint.length === 0) {
    invalid('embedding.endpoint', configPath, 'a non-empty string');
  }
  if (typeof embedding.model !== 'string' || embedding.model.length === 0) {
    invalid('embedding.model', configPath, 'a non-empty string');
  }
  if (embedding.digest !== undefined && (typeof embedding.digest !== 'string' || embedding.digest.length === 0)) {
    invalid('embedding.digest', configPath, 'a non-empty string');
  }
  // Two budgets, two paths: the index/background path (default 10s) tolerates a cold
  // model load; recall (default 400ms) stays tight fail-soft. See spec decisions register.
  const timeoutMs = positiveTimeout(embedding.timeoutMs, 10000, 'embedding.timeoutMs', configPath);
  const recallTimeoutMs = positiveTimeout(embedding.recallTimeoutMs, 400, 'embedding.recallTimeoutMs', configPath);
  return { endpoint: embedding.endpoint, model: embedding.model, ...(embedding.digest ? { digest: embedding.digest } : {}), timeoutMs, recallTimeoutMs };
}

export function loadConfig(configPath = CONFIG_PATH): LibrarianConfig {
  if (!fs.existsSync(configPath)) {
    return { inference: { provider: 'opencode', model: 'opencode/big-pickle' }, embedding: undefined, scoring: scoringConfig(undefined, configPath) };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`invalid Librarian config ${configPath}: ${reason}`);
  }

  const root = typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : {};
  const inference = typeof root.inference === 'object' && root.inference !== null
    ? root.inference as Record<string, unknown>
    : {};
  const provider = inference.provider ?? 'opencode';
  if (provider !== 'claude' && provider !== 'opencode') {
    throw new Error(`invalid inference.provider in ${configPath}: ${String(provider)}`);
  }
  if (inference.model !== undefined && typeof inference.model !== 'string') {
    throw new Error(`invalid inference.model in ${configPath}: expected a string`);
  }
  const model = (inference.model as string | undefined) ?? (provider === 'opencode' ? 'opencode/big-pickle' : undefined);
  return { inference: { provider, model }, embedding: embeddingConfig(root.embedding, configPath), scoring: scoringConfig(root.scoring, configPath) };
}
