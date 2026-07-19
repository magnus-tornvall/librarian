import tseslint from 'typescript-eslint'

// ponytail: type-aware correctness only, not the full recommended set.
// The reason this linter exists is the rules tsc --strict can't see —
// mainly dropped awaits in the async pipeline. Widen deliberately, not by default.
export default tseslint.config({
  files: ['src/**/*.ts'],
  extends: [tseslint.configs.base],
  languageOptions: {
    parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
  },
  rules: {
    '@typescript-eslint/no-floating-promises': 'error',
    '@typescript-eslint/no-misused-promises': 'error',
    '@typescript-eslint/await-thenable': 'error',
    '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
  },
})
