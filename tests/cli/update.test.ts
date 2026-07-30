import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { latestVersion } from '../../src/update.ts';

const CLI = path.join(import.meta.dirname, '..', '..', 'src', 'cli.ts');
let server: ChildProcess | undefined;
let tagsUrl = '';

async function startTags(tags: string[]): Promise<string> {
  server?.kill();
  const program = `require('http').createServer((_, r) => r.end(${JSON.stringify(JSON.stringify(tags.map((name) => ({ name }))))})).listen(0, '127.0.0.1', function () { console.log(this.address().port) })`;
  server = spawn(process.execPath, ['-e', program], { stdio: ['ignore', 'pipe', 'inherit'] });
  const port = await new Promise<string>((resolve, reject) => {
    server!.stdout!.once('data', (data: Buffer) => resolve(data.toString().trim()));
    server!.once('error', reject);
  });
  return `http://127.0.0.1:${port}`;
}

after(() => server?.kill());

test('tag discovery ignores invalid tags and compares numeric triples', async () => {
  tagsUrl = await startTags(['v1.9.0', 'preview', 'v1.10.0', 'v2.0.0-beta', 'v1.2.3']);
  const previous = process.env.LIBRARIAN_TAGS_URL;
  process.env.LIBRARIAN_TAGS_URL = tagsUrl;
  try {
    assert.equal((await latestVersion())?.text, 'v1.10.0');
  } finally {
    if (previous === undefined) delete process.env.LIBRARIAN_TAGS_URL;
    else process.env.LIBRARIAN_TAGS_URL = previous;
  }
});

test('update check reports a dev build and source apply refuses', async () => {
  tagsUrl = await startTags(['v9.0.0']);
  const env = { ...process.env, LIBRARIAN_TAGS_URL: tagsUrl };
  const check = spawnSync(process.execPath, [CLI, 'update', '--check'], { encoding: 'utf8', env });
  assert.equal(check.status, 0, check.stderr);
  assert.match(check.stdout, /Development build/);

  const apply = spawnSync(process.execPath, [CLI, 'update'], { encoding: 'utf8', env });
  assert.equal(apply.status, 1);
  assert.match(apply.stderr, /requires an installed Librarian binary/);
});

test('a failed tag endpoint does not prevent normal commands', () => {
  const result = spawnSync(process.execPath, [CLI, '--version'], {
    encoding: 'utf8', env: { ...process.env, LIBRARIAN_TAGS_URL: 'http://127.0.0.1:1' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /librarian 0\.0\.0-dev/);
});
