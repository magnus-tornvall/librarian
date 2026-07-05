# 017 — src/distill/provider.ts (interface + fixture stub)

**Phase:** 3 — Walking skeleton
**Spec pointer:** `docs/specs/librarian-design-consolidated.md` §2 (swapping the distillation LLM = "swap an inference provider"), §5 ("Deleted / deferred": "Inference-provider schema-negotiation sophistication (completion + JSON-schema + validate + one retry)")
**Do not relitigate:** exactly one method, no schema-negotiation sophistication, no retry logic yet (§5 explicitly caps this at "completion + JSON-schema + validate + one retry" as the *eventual* ceiling — this task builds the interface and a test stub only; a real retry-once wrapper is not required here and would be over-building ahead of need). Do not add provider auto-discovery or a provider registry — §14 hasn't asked for one and §5's anti-generic stance applies.

## Context

Depends on 002 only. §14's test convention (no live API calls in black-box tests) is why this interface exists: task 018's distiller must be testable without actually shelling out to `claude -p`. The real `claude -p` provider is explicitly **not** part of this task's done-check — it's mentioned so a future task (not in this backlog) knows where to plug it in.

## Task

Create `src/distill/provider.ts` exporting:
```ts
export type InferenceProvider = {
  complete(prompt: string): Promise<string>;
};

export function makeFixtureProvider(response: string): InferenceProvider
```
`makeFixtureProvider` returns an `InferenceProvider` whose `complete()` ignores its argument and resolves to the given canned `response` string — this is the test double, not a real provider.

Create `tests/distill/provider.test.ts`: `makeFixtureProvider('{"foo":"bar"}').complete('anything')` resolves to `'{"foo":"bar"}'`.

## Done-check

```
npm test
```
Expect: `tests/distill/provider.test.ts` passes.
