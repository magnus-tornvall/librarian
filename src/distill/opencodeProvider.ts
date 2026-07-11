import { spawnSync } from 'node:child_process';
import type { InferenceProvider } from './provider.ts';

// Wildcards, not an enumerated allow-list: `tools: { '*': false }` strips every
// tool schema from what the model sees (no read/grep/webfetch/task either), and
// `permission: { '*': 'deny' }` is the execution backstop for anything that
// slips through. The read-side tools are the dangerous ones for a distiller —
// read/grep bypass the redact-before-append boundary (nothing re-redacts at note
// append), webfetch/websearch are exfiltration channels, and any extra context
// breaks the note-log provenance contract (a note must be derivable from its
// cited event range only). Wildcards also survive OpenCode adding new
// default-enabled tools, which an enumerated list would silently let drift open.
const OPENCODE_CONFIG_CONTENT = JSON.stringify({
  tools: { '*': false },
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
