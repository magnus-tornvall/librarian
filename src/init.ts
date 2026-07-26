import fs from 'node:fs';
import path from 'node:path';
import type { Prompter } from './prompt.ts';

/**
 * `librarian init` — the universal guided setup engine (spec §14 amendment).
 * It detects the environment, walks provider / embedding / vault / surface
 * choices, and writes the *canonical* `~/.librarian/config.json` (file-over-app:
 * the wizard is an editor). It detects and confirms host wiring; it does not
 * author it (Claude Code hook JSON is the plugin manifest, #154).
 */
export type Detected = {
  agents: string[]; // subset of ['claude', 'opencode'] found on PATH
  ollamaEndpoint: string;
  ollamaModels?: string[]; // undefined = endpoint unreachable
};

function onPath(name: string): boolean {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  return dirs.some((dir) => {
    try {
      fs.accessSync(path.join(dir, name), fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

export async function probeOllama(endpoint: string): Promise<string[] | undefined> {
  try {
    const response = await fetch(`${endpoint.replace(/\/$/, '')}/api/tags`, { signal: AbortSignal.timeout(500) });
    if (!response.ok) return undefined;
    const body = await response.json() as { models?: Array<{ name?: unknown }> };
    return (body.models ?? []).map((model) => model.name).filter((name): name is string => typeof name === 'string');
  } catch {
    return undefined; // fail-soft: absent/slow Ollama degrades the option, never throws
  }
}

export async function detectEnvironment(): Promise<Detected> {
  // ponytail: LIBRARIAN_OLLAMA_URL is a test seam so detection is deterministic
  // regardless of whether the host happens to run Ollama; default is the real port.
  const ollamaEndpoint = process.env.LIBRARIAN_OLLAMA_URL ?? 'http://127.0.0.1:11434';
  return {
    agents: ['claude', 'opencode'].filter(onPath),
    ollamaEndpoint,
    ollamaModels: await probeOllama(ollamaEndpoint),
  };
}

function surfaceInstructions(agent: string): string {
  if (agent === 'claude') {
    return '  Claude Code: install the plugin — `/plugin marketplace add <librarian>` then `/plugin install librarian` (#154).';
  }
  return '  OpenCode: install the plugin per adapters/opencode/README.md (#155).';
}

export function readRawConfig(configPath: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8')) as unknown;
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {}; // absent or malformed: start clean, wizard rewrites managed keys
  }
}

type WizardResult = {
  provider: 'claude' | 'opencode';
  model?: string;
  embedding?: { endpoint: string; model: string };
  vault?: string;
};

/**
 * Merge managed keys (inference, embedding, vault) over the existing config,
 * preserving every unmanaged key (e.g. `scoring`) so a re-run never drops them.
 */
function writeConfig(existing: Record<string, unknown>, configPath: string, result: WizardResult): Record<string, unknown> {
  const next = existing;
  next.inference = { provider: result.provider, ...(result.model ? { model: result.model } : {}) };
  if (result.embedding) next.embedding = result.embedding;
  else delete next.embedding;
  if (result.vault) next.vault = result.vault;
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

export async function runInitWizard(prompter: Prompter, detected: Detected, configPath: string): Promise<void> {
  // Existing config drives the defaults so a re-run edits in place (file-over-app:
  // the wizard is an editor) — blank keeps the shown current value.
  const existing = readRawConfig(configPath);
  const currentInference = existing.inference !== null && typeof existing.inference === 'object' ? existing.inference as Record<string, unknown> : {};
  const currentProvider = currentInference.provider === 'claude' || currentInference.provider === 'opencode' ? currentInference.provider : undefined;
  const currentModel = typeof currentInference.model === 'string' ? currentInference.model : undefined;
  const currentVault = typeof existing.vault === 'string' ? existing.vault : '';

  prompter.say('Detected environment:');
  prompter.say(`  agent CLIs on PATH: ${detected.agents.length ? detected.agents.join(', ') : 'none'}`);
  prompter.say(`  Ollama: ${detected.ollamaModels ? `reachable (${detected.ollamaModels.length} models)` : 'not detected'}`);
  prompter.say('');

  const providerDefault = currentProvider ?? (detected.agents[0] === 'claude' ? 'claude' : 'opencode');
  const provider = await prompter.select('Inference provider', ['claude', 'opencode'] as const, providerDefault);
  const model = provider === 'opencode' ? await prompter.ask('OpenCode model', currentModel ?? 'opencode/big-pickle') : undefined;

  const embeddingChoice = await prompter.select('Embedding', ['off', 'ollama-local', 'custom'] as const, detected.ollamaModels ? 'ollama-local' : 'off');
  let embedding: WizardResult['embedding'];
  if (embeddingChoice === 'ollama-local') {
    const guess = detected.ollamaModels?.find((name) => name.includes('embed')) ?? detected.ollamaModels?.[0] ?? '';
    const embeddingModel = await prompter.ask('Embedding model', guess);
    if (embeddingModel) embedding = { endpoint: detected.ollamaEndpoint, model: embeddingModel };
  } else if (embeddingChoice === 'custom') {
    const endpoint = await prompter.ask('Embedding endpoint');
    const embeddingModel = await prompter.ask('Embedding model');
    if (endpoint && embeddingModel) embedding = { endpoint, model: embeddingModel };
  }

  const vault = await prompter.ask('Vault path (blank to keep current)', currentVault);

  for (const agent of detected.agents) {
    if (await prompter.confirm(`Show ${agent} wiring instructions?`, true)) {
      prompter.say(surfaceInstructions(agent));
    }
  }

  writeConfig(existing, configPath, { provider, model, embedding, vault: vault || undefined });
  prompter.say(`\nWrote ${configPath}`);
}
