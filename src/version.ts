// The build stamps the real version in at compile time via esbuild
// `--define:__LIBRARIAN_VERSION__` (see scripts/build-sea.sh). Run-from-source
// (`node dist/cli.js`) leaves the define unset, so it reads as the dev sentinel.
declare const __LIBRARIAN_VERSION__: string | undefined;

export const VERSION =
  typeof __LIBRARIAN_VERSION__ === 'string' ? __LIBRARIAN_VERSION__ : '0.0.0-dev';
