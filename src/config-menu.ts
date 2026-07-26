import fs from 'node:fs';
import path from 'node:path';
import type { Prompter } from './prompt.ts';
import { readRawConfig, probeOllama } from './init.ts';

/**
 * `librarian config` — a curated per-setting editor over the canonical
 * `~/.librarian/config.json` (spec §14 amendment: file-over-app, the menu is an
 * editor, never a second store). Covers provider / embedding / vault only —
 * `scoring` is expert tuning with no sensible-default picklist and is
 * round-tripped untouched along with every other unmanaged key.
 */

// A `custom…` sentinel appended to enum picklists — chosen, it falls through to
// free-text ask(), the composition the #153 decision comment calls for.
const CUSTOM = 'custom…';

function currentInference(existing: Record<string, unknown>): Record<string, unknown> {
  return existing.inference !== null && typeof existing.inference === 'object' && !Array.isArray(existing.inference)
    ? existing.inference as Record<string, unknown>
    : {};
}

async function editProvider(prompter: Prompter, existing: Record<string, unknown>): Promise<void> {
  const inference = currentInference(existing);
  const current = inference.provider === 'claude' || inference.provider === 'opencode' ? inference.provider : 'opencode';
  const provider = await prompter.select('Inference provider', ['claude', 'opencode'] as const, current);
  const currentModel = typeof inference.model === 'string' ? inference.model : undefined;
  // For claude the model is optional (provider default); only carry a prior model
  // forward if it isn't the opencode default left over from a provider switch.
  const model = provider === 'opencode'
    ? await prompter.ask('OpenCode model', currentModel ?? 'opencode/big-pickle')
    : await prompter.ask('Model (blank for provider default)', currentModel && currentModel !== 'opencode/big-pickle' ? currentModel : '');
  existing.inference = { provider, ...(model ? { model } : {}) };
}

async function editEmbedding(prompter: Prompter, existing: Record<string, unknown>): Promise<void> {
  const endpoint = process.env.LIBRARIAN_OLLAMA_URL ?? 'http://127.0.0.1:11434';
  const models = await probeOllama(endpoint);
  const currentEmbedding = existing.embedding !== null && typeof existing.embedding === 'object' && !Array.isArray(existing.embedding)
    ? existing.embedding as Record<string, unknown>
    : undefined;
  const currentDefault = currentEmbedding ? 'ollama-local' : 'off';

  const choice = await prompter.select(
    `Embedding (Ollama ${models ? `reachable, ${models.length} models` : 'not detected'})`,
    ['off', 'ollama-local', CUSTOM] as const,
    currentDefault,
  );
  if (choice === 'off') {
    delete existing.embedding;
    return;
  }
  if (choice === 'ollama-local') {
    // detect-and-confirm: guess an embed model from the installed list, let the
    // operator confirm or override rather than hardcoding a picklist.
    const guess = models?.find((name) => name.includes('embed')) ?? models?.[0] ?? (typeof currentEmbedding?.model === 'string' ? currentEmbedding.model : '');
    const model = await prompter.ask('Embedding model', guess);
    if (model) existing.embedding = { ...(currentEmbedding ?? {}), endpoint, model };
    return;
  }
  // custom endpoint + model
  const customEndpoint = await prompter.ask('Embedding endpoint', typeof currentEmbedding?.endpoint === 'string' ? currentEmbedding.endpoint : '');
  const customModel = await prompter.ask('Embedding model', typeof currentEmbedding?.model === 'string' ? currentEmbedding.model : '');
  if (customEndpoint && customModel) existing.embedding = { ...(currentEmbedding ?? {}), endpoint: customEndpoint, model: customModel };
}

async function editVault(prompter: Prompter, existing: Record<string, unknown>): Promise<void> {
  const current = typeof existing.vault === 'string' ? existing.vault : '';
  const vault = await prompter.ask('Vault path (blank to keep current)', current);
  if (vault) existing.vault = vault;
}

export async function runConfigMenu(prompter: Prompter, configPath: string): Promise<void> {
  // Round-trip the whole file: we mutate only the managed keys on `existing`,
  // leaving `scoring` and unknown keys exactly as read.
  const existing = readRawConfig(configPath);

  const section = await prompter.select('Configure', ['provider', 'embedding', 'vault'] as const, 'provider');
  if (section === 'provider') await editProvider(prompter, existing);
  else if (section === 'embedding') await editEmbedding(prompter, existing);
  else await editVault(prompter, existing);

  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(existing, null, 2)}\n`);
  prompter.say(`\nWrote ${configPath}`);
}
