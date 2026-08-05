import { excerpt } from '../render/distillPrompt.ts';
import { redactOutput } from '../redact.ts';

/** How much of a malformed provider response the error message names. One ordinary
 *  truncated JSON judgment fits; a runaway response is cut. */
const PROVIDER_EXCERPT_CHARS = 400;

/** How much of the head to redact before excerpting — enough raw text that a
 *  whitespace-dense response still fills the excerpt. */
const REDACT_CHARS = PROVIDER_EXCERPT_CHARS * 8;

/**
 * The distillation LLM behind exactly one seam: `complete(prompt) -> text`.
 * Swapping the model (§2) means swapping an `InferenceProvider`, nothing more —
 * no schema-negotiation, no retry registry, no provider auto-discovery. §5 caps
 * the eventual ceiling at "completion + JSON-schema + validate + one retry"; that
 * retry-once wrapper is deliberately not built here.
 */
export type InferenceProvider = {
  /** Exact model selector, when provenance requires one. */
  readonly model?: string;
  complete(prompt: string): Promise<string>;
};

/**
 * The test double: an `InferenceProvider` whose `complete()` ignores its prompt
 * and resolves to the canned `response`. This is how the distiller (018) and its
 * tests exercise the pipeline without a live `claude -p` call.
 */
export function makeFixtureProvider(response: string, model?: string): InferenceProvider {
  return {
    ...(model ? { model } : {}),
    complete(_prompt: string): Promise<string> {
      return Promise.resolve(response);
    },
  };
}

/** Ordered canned responses for integration tests that make several model calls. */
export function makeScriptedFixtureProvider(responses: string[], model?: string): InferenceProvider {
  let next = 0;
  return {
    ...(model ? { model } : {}),
    complete(_prompt: string): Promise<string> {
      if (next === responses.length) {
        return Promise.reject(new Error('fixture provider ran out of scripted responses'));
      }
      return Promise.resolve(responses[next++]);
    },
  };
}

/** Strip a ```json fence a model wrapped its answer in — the one formatting habit
 *  common enough that rejecting it would reject correct judgments. */
function unfence(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n?```$/);
  return match ? match[1].trim() : trimmed;
}

/**
 * Parse a provider response as JSON, naming a bounded, redacted excerpt of the
 * offending text in the error.
 *
 * The raw response is never stored anywhere, so a bare `SyntaxError` ("Expected
 * ',' at position 637") is undiagnosable after the fact — it says a model
 * misbehaved without saying how, and the run that produced it is gone. The
 * excerpt rides the error message into the cursor's `failed_attempts.last_error`
 * and the quarantine verdict, which is the log we already keep.
 *
 * Redact BEFORE excerpting: truncating first can cut a secret in half and hand
 * the detector a fragment it no longer recognises. `redactOutput` (not `redact`)
 * because this is machine output — an unclosed `<private>` must not swallow the
 * failure text.
 */
export async function parseProviderJson(raw: string): Promise<unknown> {
  try {
    return JSON.parse(unfence(raw));
  } catch (err) {
    const safe = await redactOutput(raw.slice(0, REDACT_CHARS));
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`provider response is not JSON (${message}); response: ${excerpt(safe, PROVIDER_EXCERPT_CHARS)}`);
  }
}
