import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { redact, redactOutput } from '../src/redact.ts';

const GOLDEN_DIR = path.join(import.meta.dirname, '..', 'schema', 'examples', 'event');

test('plain text with no secret-shaped substring passes through unchanged', async () => {
  const text = 'git status && ls -la';
  assert.equal(await redact(text), text);
});

test('replaces private spans without retaining their content or a correlation hash', async () => {
  const result = await redact('keep <private>do not persist this</private> and <private>this either</private>');
  assert.equal(result, 'keep [PRIVATE] and [PRIVATE]');
  assert.ok(!result.includes('do not persist this'));
  assert.ok(!result.includes('sha256'));
});

test('private spans are fail-closed when unclosed and support nesting', async () => {
  assert.equal(await redact('keep <private>outer <private>inner</private> secret</private> end'), 'keep [PRIVATE] end');
  assert.equal(await redact('keep <private>do not persist'), 'keep [PRIVATE]');
});

// --- redactOutput: machine text, not human text (#179) --------------------------------

test('redactOutput does NOT fail closed on an unclosed private tag', async () => {
  // The bug this guards: a `<private>` that is an accident of a test diff, not a
  // declaration, would otherwise truncate everything after it — permanently, on a log that
  // is never deleted, destroying the exact failure text the capture exists to keep.
  const output = 'FAIL x.spec.ts\n  expected <private>true</privat\nREAL ERROR: ENOENT config.yml\n';
  assert.equal(await redact(output), 'FAIL x.spec.ts\n  expected [PRIVATE]', 'human text still fails closed');
  // Left verbatim, tag and all — the same treatment an unclosed `<librarian-memory>` gets.
  assert.equal(await redactOutput(output), output, 'machine text is kept whole');
});

test('redactOutput still strips a well-formed private span', async () => {
  assert.equal(await redactOutput('a <private>b</private> c'), 'a [PRIVATE] c');
});

test('redactOutput applies the secret patterns and the memory-echo strip', async () => {
  const secret = 'ghp_' + 'E'.repeat(36);
  assert.match(await redactOutput(secret), /^\[REDACTED:token:sha256:[0-9a-f]{8}\]$/);
  assert.equal(await redactOutput('out <librarian-memory>echo</librarian-memory> put'), 'out  put');
});

test('removes all injected librarian-memory blocks', async () => {
  assert.equal(
    await redact('ask <librarian-memory injection_id="first">first <librarian-memory>nested</librarian-memory></librarian-memory> now <librarian-memory indexed_through="now">second</librarian-memory>'),
    'ask  now ',
  );
});

test('preserves an unclosed librarian-memory tag as literal prompt text', async () => {
  const text = 'show <librarian-memory> literally';
  assert.equal(await redact(text), text);
});

test('redacts an AWS-style access key', async () => {
  const result = await redact('export AWS_ACCESS_KEY_ID=AKIAABCDEFGHIJKLMNOP');
  assert.match(result, /^export AWS_ACCESS_KEY_ID=\[REDACTED:token:sha256:[0-9a-f]{8}\]$/);
});

test('redacts a generic api_key-shaped token', async () => {
  const result = await redact('curl -H "api_key: AbCdEfGh12345678ijklmnop"');
  assert.match(result, /^curl -H "\[REDACTED:token:sha256:[0-9a-f]{8}\]"$/);
});

test('redacts a JSON-shaped api_key value (quoted key, colon, quoted value)', async () => {
  const result = await redact('curl -d \'{"api_key":"AbCdEfGh12345678ijklmnop"}\'');
  assert.match(result, /^curl -d '\{"\[REDACTED:token:sha256:[0-9a-f]{8}\]"\}'$/);
});

test('does not redact "secret" as a substring of an unrelated word', async () => {
  const text = 'the secretary filed the report';
  assert.equal(await redact(text), text);
});

test('redacts a GitHub PAT', async () => {
  const pat = 'ghp_' + 'A'.repeat(36);
  const result = await redact(`git remote set-url origin https://${pat}@github.com/x/y.git`);
  assert.match(result, /^git remote set-url origin https:\/\/\[REDACTED:token:sha256:[0-9a-f]{8}\]@github\.com\/x\/y\.git$/);
});

test('the same secret redacts to the same tag across two separate calls', async () => {
  const secret = 'api_key=AbCdEfGh12345678ijklmnop';
  const firstTag = (await redact(`start ${secret} end`)).match(/\[REDACTED:token:sha256:[0-9a-f]{8}\]/)?.[0];
  const secondTag = (await redact(`other context ${secret} tail`)).match(/\[REDACTED:token:sha256:[0-9a-f]{8}\]/)?.[0];
  assert.ok(firstTag);
  assert.equal(firstTag, secondTag);
});

test('reproduces the shape of the golden redacted-command example', async () => {
  const golden = JSON.parse(
    fs.readFileSync(path.join(GOLDEN_DIR, '04-redacted-command-with-token.json'), 'utf8'),
  );
  const pat = 'ghp_' + 'B'.repeat(36);
  const preRedaction = `curl -H "Authorization: Bearer ${pat}" https://api.example.com/deploy`;
  const result = await redact(preRedaction);
  assert.match(
    result,
    /^curl -H "Authorization: Bearer \[REDACTED:token:sha256:[0-9a-f]{8}\]" https:\/\/api\.example\.com\/deploy$/,
  );
  assert.match(golden.command, /^curl -H "Authorization: Bearer \[REDACTED:token:sha256:\S+\]" https:\/\/api\.example\.com\/deploy$/);
});

// --- secretlint-backed corpus (#178) ---------------------------------------------------

test('redacts an Anthropic API key that the hand-rolled patterns miss', async () => {
  const secret = 'sk-ant-api03-' + 'A'.repeat(95);
  const result = await redact(`export ANTHROPIC_API_KEY=${secret}`);
  assert.ok(!result.includes(secret));
  assert.match(result, /\[REDACTED:token:sha256:[0-9a-f]{8}\]/);
});

test('redacts a modern GitHub token format the hand-rolled patterns miss', async () => {
  const secret = 'github_pat_' + 'A'.repeat(82);
  const result = await redact(`git remote set-url origin https://${secret}@github.com/x/y.git`);
  assert.ok(!result.includes(secret));
  assert.match(result, /\[REDACTED:token:sha256:[0-9a-f]{8}\]/);
});

test('redacts a database connection string', async () => {
  const result = await redact('DATABASE_URL=postgres://admin:hunter2@db.internal:5432/prod');
  assert.ok(!result.includes('hunter2'));
  assert.match(result, /\[REDACTED:token:sha256:[0-9a-f]{8}\]/);
});

test('redacts a private key block', async () => {
  const body = 'MIIEowIBAAKCAQEA'.repeat(10);
  const key = `-----BEGIN RSA PRIVATE KEY-----\n${body}\n-----END RSA PRIVATE KEY-----`;
  const result = await redact(`deploy key:\n${key}`);
  assert.ok(!result.includes(body));
  assert.match(result, /\[REDACTED:token:sha256:[0-9a-f]{8}\]/);
});

test('still redacts a bare AKIA key id — the case secretlint misses on its own', async () => {
  // secretlint's `aws` rule only matches the secret-access-key shape, not the bare key id
  // (measured in #178). The hand-rolled pattern stays for exactly this case.
  const result = await redact('AWS_ACCESS_KEY_ID=AKIAABCDEFGHIJKLMNOP');
  assert.match(result, /^AWS_ACCESS_KEY_ID=\[REDACTED:token:sha256:[0-9a-f]{8}\]$/);
});

test('redacts a value present in the process environment even though it matches no pattern', async () => {
  process.env.LIBRARIAN_TEST_TOKEN = 'not-a-recognizable-secret-shape';
  try {
    const result = await redact('ping using LIBRARIAN_TEST_TOKEN=not-a-recognizable-secret-shape');
    assert.ok(!result.includes('not-a-recognizable-secret-shape'));
    assert.match(result, /\[REDACTED:token:sha256:[0-9a-f]{8}\]/);
  } finally {
    delete process.env.LIBRARIAN_TEST_TOKEN;
  }
});

test('redacts a GCP service-account key — the ext-dispatched rule the naive integration misses', async () => {
  // secretlint's gcp rule dispatches on source.ext (".json"/".p12") — a bare filePath with no
  // ext, the naive way to call lintSource, reports zero hits on real service-account JSON.
  const privateKeyBody = 'A'.repeat(200);
  const serviceAccountJson = JSON.stringify({
    type: 'service_account',
    project_id: 'my-project',
    private_key_id: 'abc123',
    private_key: `-----BEGIN PRIVATE KEY-----\n${privateKeyBody}\n-----END PRIVATE KEY-----\n`,
    client_email: 'sa@my-project.iam.gserviceaccount.com',
  });
  const result = await redact(serviceAccountJson);
  assert.ok(!result.includes(privateKeyBody));
  assert.match(result, /\[REDACTED:token:sha256:[0-9a-f]{8}\]/);
});

test('does not redact an env var whose value merely looks ordinary because its name loosely mentions auth', async () => {
  const before = { AUTH_MODE: process.env.AUTH_MODE, FIREBASE_AUTH_DOMAIN: process.env.FIREBASE_AUTH_DOMAIN };
  process.env.AUTH_MODE = 'production';
  process.env.FIREBASE_AUTH_DOMAIN = 'myapp.firebaseapp.com';
  try {
    const modeResult = await redact('deploy to production and run tests');
    assert.equal(modeResult, 'deploy to production and run tests', 'AUTH_MODE is config, not a credential');

    const domainResult = await redact('using myapp.firebaseapp.com for auth');
    assert.equal(domainResult, 'using myapp.firebaseapp.com for auth', 'a domain-shaped value is not a credential');
  } finally {
    if (before.AUTH_MODE === undefined) delete process.env.AUTH_MODE;
    else process.env.AUTH_MODE = before.AUTH_MODE;
    if (before.FIREBASE_AUTH_DOMAIN === undefined) delete process.env.FIREBASE_AUTH_DOMAIN;
    else process.env.FIREBASE_AUTH_DOMAIN = before.FIREBASE_AUTH_DOMAIN;
  }
});

test('a shorter known env value does not consume a longer one that shares its prefix', async () => {
  const before = { A_TOKEN: process.env.A_TOKEN, B_TOKEN: process.env.B_TOKEN };
  process.env.A_TOKEN = 'abcdefghijkl';
  process.env.B_TOKEN = 'abcdefghijklMNOPQRST';
  try {
    const result = await redact('value abcdefghijklMNOPQRST here');
    assert.ok(!result.includes('MNOPQRST'), 'the longer secret\'s tail must not survive in clear');
    assert.match(result, /^value \[REDACTED:token:sha256:[0-9a-f]{8}\] here$/);
  } finally {
    if (before.A_TOKEN === undefined) delete process.env.A_TOKEN;
    else process.env.A_TOKEN = before.A_TOKEN;
    if (before.B_TOKEN === undefined) delete process.env.B_TOKEN;
    else process.env.B_TOKEN = before.B_TOKEN;
  }
});

test('a git commit message, a file path, and a git SHA survive redaction unchanged', async () => {
  const text = 'git commit -m "fix: normalize paths" -- src/collector/append.ts a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
  assert.equal(await redact(text), text);
});

test('redaction is idempotent — redacting already-redacted text is a no-op', async () => {
  const secret = 'sk-ant-api03-' + 'A'.repeat(95);
  const once = await redact(`token: ${secret}`);
  const twice = await redact(once);
  assert.equal(twice, once);
});
