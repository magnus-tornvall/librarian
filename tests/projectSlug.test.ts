import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectSlugFromGitRoot } from '../src/projectSlug.ts';

test('project slug uses the checkout directory on Unix and Windows paths', () => {
  assert.equal(projectSlugFromGitRoot('/work/librarian/'), 'librarian');
  assert.equal(projectSlugFromGitRoot('C:\\work\\librarian'), 'librarian');
  assert.equal(projectSlugFromGitRoot(undefined), undefined);
});
