import fs from 'node:fs';
import { CONFIG_PATH } from './paths.ts';
import { DEFAULT_SCORING_CONFIG, type ScoringConfig } from './recall/scoring.ts';

export type LibrarianConfig = {
  inference: {
    provider: 'claude' | 'opencode';
    model?: string;
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

export function loadConfig(configPath = CONFIG_PATH): LibrarianConfig {
  if (!fs.existsSync(configPath)) {
    return { inference: { provider: 'claude' }, scoring: scoringConfig(undefined, configPath) };
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
  const provider = inference.provider ?? 'claude';
  if (provider !== 'claude' && provider !== 'opencode') {
    throw new Error(`invalid inference.provider in ${configPath}: ${String(provider)}`);
  }
  if (inference.model !== undefined && typeof inference.model !== 'string') {
    throw new Error(`invalid inference.model in ${configPath}: expected a string`);
  }
  return { inference: { provider, model: inference.model as string | undefined }, scoring: scoringConfig(root.scoring, configPath) };
}
