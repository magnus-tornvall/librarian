import fs from 'node:fs';
import { CONFIG_PATH } from './paths.ts';

export type LibrarianConfig = {
  inference: {
    provider: 'claude' | 'opencode';
    model?: string;
  };
};

export function loadConfig(configPath = CONFIG_PATH): LibrarianConfig {
  if (!fs.existsSync(configPath)) {
    return { inference: { provider: 'claude' } };
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
  return { inference: { provider, model: inference.model as string | undefined } };
}
