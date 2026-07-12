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

/** Backward-compatible fixture adapter for legacy one-note response files. */
export function makeVerifyingFixtureProvider(response: string, model?: string): InferenceProvider {
  const faithful = JSON.stringify({ faithful: true, errors: [], reason: 'Fixture note is faithful.' });
  return {
    ...(model ? { model } : {}),
    complete(prompt: string): Promise<string> {
      return Promise.resolve(prompt.startsWith('Check whether the note is faithful') ? faithful : response);
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
