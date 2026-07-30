/**
 * Derive a stable project slug from git_remote + directory name.
 * Remote identity ensures two clones under different directory names
 * resolve to the same scope, and prevents unrelated repos from colliding.
 */
export function projectSlugFromGitRoot(gitRoot: unknown, gitRemote: unknown = undefined): string | undefined {
  if (typeof gitRoot !== 'string') return undefined;
  const dirName = gitRoot.split(/[\\/]/).filter(Boolean).at(-1);
  if (!dirName) return undefined;

  if (typeof gitRemote === 'string') {
    const slug = extractRepoIdentifier(gitRemote);
    if (slug) return slug;
  }
  return dirName;
}

/**
 * Extract repository identifier from git remote URL.
 * Handles https://, git@, and file:// URLs, falling back to undefined for unrecognized formats.
 */
function extractRepoIdentifier(gitRemote: string): string | undefined {
  // Match https://host/path/repo.git or git@host:path/repo.git
  const match = gitRemote.match(/(?:https?:\/\/|git@)[^:\/]+[:/](.+?)(?:\.git)?$/);
  if (match) {
    return match[1].replace(/\//g, ':');
  }
  return undefined;
}
