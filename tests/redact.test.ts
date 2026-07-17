import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { redact } from '../src/redact.ts';

const GOLDEN_DIR = path.join(import.meta.dirname, '..', 'schema', 'examples', 'event');

test('plain text with no secret-shaped substring passes through unchanged', () => {
  const text = 'git status && ls -la';
  assert.equal(redact(text), text);
});

test('replaces private spans without retaining their content or a correlation hash', () => {
  const result = redact('keep <private>do not persist this</private> and <private>this either</private>');
  assert.equal(result, 'keep [PRIVATE] and [PRIVATE]');
  assert.ok(!result.includes('do not persist this'));
  assert.ok(!result.includes('sha256'));
});

test('private spans are fail-closed when unclosed and support nesting', () => {
  assert.equal(redact('keep <private>outer <private>inner</private> secret</private> end'), 'keep [PRIVATE] end');
  assert.equal(redact('keep <private>do not persist'), 'keep [PRIVATE]');
});

test('removes all injected librarian-memory blocks', () => {
  assert.equal(
    redact('ask <librarian-memory>first <librarian-memory>nested</librarian-memory></librarian-memory> now <librarian-memory>second</librarian-memory>'),
    'ask  now ',
  );
});

test('redacts an AWS-style access key', () => {
  const result = redact('export AWS_ACCESS_KEY_ID=AKIAABCDEFGHIJKLMNOP');
  assert.match(result, /^export AWS_ACCESS_KEY_ID=\[REDACTED:token:sha256:[0-9a-f]{8}\]$/);
});

test('redacts a generic api_key-shaped token', () => {
  const result = redact('curl -H "api_key: AbCdEfGh12345678ijklmnop"');
  assert.match(result, /^curl -H "\[REDACTED:token:sha256:[0-9a-f]{8}\]"$/);
});

test('redacts a JSON-shaped api_key value (quoted key, colon, quoted value)', () => {
  const result = redact('curl -d \'{"api_key":"AbCdEfGh12345678ijklmnop"}\'');
  assert.match(result, /^curl -d '\{"\[REDACTED:token:sha256:[0-9a-f]{8}\]"\}'$/);
});

test('does not redact "secret" as a substring of an unrelated word', () => {
  const text = 'the secretary filed the report';
  assert.equal(redact(text), text);
});

test('redacts a GitHub PAT', () => {
  const pat = 'ghp_' + 'A'.repeat(36);
  const result = redact(`git remote set-url origin https://${pat}@github.com/x/y.git`);
  assert.match(result, /^git remote set-url origin https:\/\/\[REDACTED:token:sha256:[0-9a-f]{8}\]@github\.com\/x\/y\.git$/);
});

test('the same secret redacts to the same tag across two separate calls', () => {
  const secret = 'api_key=AbCdEfGh12345678ijklmnop';
  const firstTag = redact(`start ${secret} end`).match(/\[REDACTED:token:sha256:[0-9a-f]{8}\]/)?.[0];
  const secondTag = redact(`other context ${secret} tail`).match(/\[REDACTED:token:sha256:[0-9a-f]{8}\]/)?.[0];
  assert.ok(firstTag);
  assert.equal(firstTag, secondTag);
});

test('reproduces the shape of the golden redacted-command example', () => {
  const golden = JSON.parse(
    fs.readFileSync(path.join(GOLDEN_DIR, '04-redacted-command-with-token.json'), 'utf8'),
  );
  const pat = 'ghp_' + 'B'.repeat(36);
  const preRedaction = `curl -H "Authorization: Bearer ${pat}" https://api.example.com/deploy`;
  const result = redact(preRedaction);
  assert.match(
    result,
    /^curl -H "Authorization: Bearer \[REDACTED:token:sha256:[0-9a-f]{8}\]" https:\/\/api\.example\.com\/deploy$/,
  );
  assert.match(golden.command, /^curl -H "Authorization: Bearer \[REDACTED:token:sha256:\S+\]" https:\/\/api\.example\.com\/deploy$/);
});
