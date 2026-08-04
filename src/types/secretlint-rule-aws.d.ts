// @secretlint/secretlint-rule-preset-recommend's .d.ts imports a type from this package even
// though the preset ships fully pre-bundled (no runtime dependency on it) — this ambient
// declaration satisfies tsc's module resolution without installing the real package and its
// transitive tree (@textlint/regexp-string-matcher, lodash.*) for a type never used at runtime.
declare module '@secretlint/secretlint-rule-aws' {
  export type Options = Record<string, never>;
}
