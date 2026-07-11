/**
 * Derive the v1 project slug from the repository directory name.
 * ponytail: same-named checkout directories collide; include remote identity when that occurs in practice.
 */
export function projectSlugFromGitRoot(gitRoot: unknown): string | undefined {
  if (typeof gitRoot !== 'string') return undefined;
  return gitRoot.split(/[\\/]/).filter(Boolean).at(-1);
}
