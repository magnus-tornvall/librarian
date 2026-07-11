import { spawnSync } from 'node:child_process';
import type { InferenceProvider } from './provider.ts';

const OPENCODE_CONFIG_CONTENT = JSON.stringify({
  tools: { write: false, edit: false, bash: false },
  permission: { '*': 'deny' },
});

/**
 * Run a tool-free OpenCode completion. `--pure` disables external plugins, so
 * Librarian's instrumentation plugin cannot capture its own distill session.
 * OpenCode merges OPENCODE_CONFIG_CONTENT after normal config, preserving the
 * user's provider/auth settings while this inline overlay enforces denial.
 */
export function makeOpencodeProvider({ model }: { model: string }): InferenceProvider {
  return {
    model,
    complete(prompt: string): Promise<string> {
      const result = spawnSync('opencode', ['run', '--pure', '-m', model], {
        input: prompt,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, OPENCODE_CONFIG_CONTENT },
      });
      if (result.error) {
        return Promise.reject(new Error(`opencode run failed to spawn: ${result.error.message}`));
      }
      if (result.status !== 0) {
        return Promise.reject(new Error(`opencode run exited ${result.status}: ${(result.stderr ?? '').trim()}`));
      }
      return Promise.resolve(result.stdout);
    },
  };
}
