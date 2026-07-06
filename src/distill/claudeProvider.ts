import { spawnSync } from 'node:child_process';
import type { InferenceProvider } from './provider.ts';

/**
 * The real `InferenceProvider`: a `claude -p` completion (§3). The prompt goes
 * in on stdin, the model's text comes back on stdout — a pure one-shot
 * completion, NOT a tool loop. This is the seam's production side; tests and
 * offline runs pass `--provider-fixture` instead so a live model is never
 * called (§2: the provider swap is the seam, nothing more).
 *
 * Fail loud (§9): a spawn failure or a non-zero `claude` exit throws, so the
 * distill run aborts with a non-zero exit and the cursor is NOT advanced —
 * the range is retried on the next run. No retry wrapper here (§5 defers it).
 */
export function makeClaudeProvider(): InferenceProvider {
  return {
    complete(prompt: string): Promise<string> {
      const result = spawnSync('claude', ['-p'], {
        input: prompt,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      });

      if (result.error) {
        return Promise.reject(
          new Error(`claude -p failed to spawn: ${result.error.message}`),
        );
      }
      if (result.status !== 0) {
        const stderr = (result.stderr ?? '').trim();
        return Promise.reject(
          new Error(`claude -p exited ${result.status}: ${stderr}`),
        );
      }
      return Promise.resolve(result.stdout);
    },
  };
}
