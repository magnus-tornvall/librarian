import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeOpencodeProvider } from '../../src/distill/opencodeProvider.ts';

function fakeOpencode(body: string): { dir: string; record: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-opencode-'));
  const record = path.join(dir, 'record.json');
  const bin = path.join(dir, 'opencode');
  fs.writeFileSync(bin, `#!/bin/sh\n${body}\n`);
  fs.chmodSync(bin, 0o755);
  return { dir, record };
}

test('OpenCode provider sends prompt on stdin with model and hardcoded tool denial', async () => {
  const fake = fakeOpencode(`node -e 'const fs=require("fs"); fs.writeFileSync(process.env.RECORD, JSON.stringify({argv:process.argv.slice(1),env:process.env.OPENCODE_CONFIG_CONTENT,stdin:fs.readFileSync(0,"utf8")})); process.stdout.write("canned")' -- "$@"`);
  const oldPath = process.env.PATH;
  process.env.PATH = `${fake.dir}${path.delimiter}${oldPath}`;
  process.env.RECORD = fake.record;
  try {
    assert.equal(await makeOpencodeProvider({ model: 'test/model' }).complete('prompt\nintact'), 'canned');
    const recorded = JSON.parse(fs.readFileSync(fake.record, 'utf8')) as { argv: string[]; env: string; stdin: string };
    assert.deepEqual(recorded.argv, ['run', '--pure', '-m', 'test/model']);
    assert.equal(recorded.stdin, 'prompt\nintact');
    const config = JSON.parse(recorded.env);
    assert.deepEqual(config.tools, { '*': false });
    assert.equal(config.permission['*'], 'deny');
  } finally {
    process.env.PATH = oldPath;
    delete process.env.RECORD;
  }
});

test('OpenCode provider reports non-zero exit and stderr', async () => {
  const fake = fakeOpencode('echo model-unavailable >&2; exit 7');
  const oldPath = process.env.PATH;
  process.env.PATH = `${fake.dir}${path.delimiter}${oldPath}`;
  try {
    await assert.rejects(makeOpencodeProvider({ model: 'test/model' }).complete('x'), /exited 7: model-unavailable/);
  } finally {
    process.env.PATH = oldPath;
  }
});
