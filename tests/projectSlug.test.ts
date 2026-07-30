import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectSlugFromGitRoot } from '../src/projectSlug.ts';

test('project slug uses git remote + directory name for stability', () => {
  // With git remote: extracts stable identifier
  assert.equal(
    projectSlugFromGitRoot('/work/librarian/', 'https://github.com/magnus-tornvall/librarian.git'),
    'magnus-tornvall:librarian',
  );
  assert.equal(
    projectSlugFromGitRoot('/work/repo-copy/', 'git@github.com:magnus-tornvall/librarian.git'),
    'magnus-tornvall:librarian',
  );
  // Without git remote: falls back to directory name
  assert.equal(projectSlugFromGitRoot('/work/librarian/'), 'librarian');
  assert.equal(projectSlugFromGitRoot('C:\\work\\librarian'), 'librarian');
  // Invalid inputs
  assert.equal(projectSlugFromGitRoot(undefined), undefined);
  assert.equal(projectSlugFromGitRoot(''), undefined);
  assert.equal(projectSlugFromGitRoot('/', undefined), undefined);
});
