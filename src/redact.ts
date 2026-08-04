import { createHash } from 'node:crypto';
import { lintSource } from '@secretlint/core';
import { creator as secretlintPresetRecommend } from '@secretlint/secretlint-rule-preset-recommend';

const SECRET_PATTERNS: RegExp[] = [
  /AKIA[0-9A-Z]{16}/g,
  /\b(?:token|api[_-]?key|secret)\b["']?[=: ]+["']?[A-Za-z0-9_\-.]{16,}/gi,
  /ghp_[A-Za-z0-9]{36}/g,
];

// Values secretlint's shape-based rules can never cover: this machine's own configured
// credentials. Checked before any pattern so a value with no recognizable shape (an internal
// token, a plain password) is still caught by what it IS, not what it looks like. Matched by
// name SUFFIX, not substring — `AUTH_MODE`, `FIREBASE_AUTH_DOMAIN`, `SSH_AUTH_SOCK` are
// ordinary config/identity, not a credential, and a substring match on "auth" would destroy
// them from every future log line, permanently, on this same non-retrofittable boundary.
const CREDENTIAL_ENV_NAME = /(?:^|_)(?:TOKEN|API[_-]?KEY|SECRET|PASSWORD|PASSWD|CREDENTIAL)$/i;
// A value that reads as a path or a domain is config/identity, not a secret — redacting it
// would be the same irreversible loss the suffix match above is trying to avoid.
const LOOKS_LIKE_PATH_OR_DOMAIN = /^(?:[a-z]+:\/\/|[./~]|[A-Za-z0-9.-]+\.[a-z]{2,})/i;
const MIN_CREDENTIAL_VALUE_LENGTH = 12;

function knownSecretValues(): string[] {
  return Object.entries(process.env)
    .filter(
      ([name, value]) =>
        CREDENTIAL_ENV_NAME.test(name) &&
        typeof value === 'string' &&
        value.length >= MIN_CREDENTIAL_VALUE_LENGTH &&
        !LOOKS_LIKE_PATH_OR_DOMAIN.test(value),
    )
    .map(([, value]) => value as string)
    // Longest first: a shorter secret that happens to be a prefix of a longer one must not
    // consume it and leave the longer secret's tail in clear.
    .sort((a, b) => b.length - a.length);
}

function tagFor(secret: string): string {
  const hash = createHash('sha256').update(secret).digest('hex').slice(0, 8);
  return `[REDACTED:token:sha256:${hash}]`;
}

function stripTagBlocks(text: string, tag: string, replacement = '', failClosed = false): string {
  const marker = new RegExp(`<(/?)${tag}(?:\\s[^>]*)?>`, 'gi');
  let result = '';
  let depth = 0;
  let last = 0;
  let openStart = 0;

  // The replacement is emitted when a block CLOSES, not when it opens: an unclosed block
  // that does not fail closed has to yield the original text back verbatim, and a
  // replacement already written into `result` could not be taken out again.
  for (const match of text.matchAll(marker)) {
    if (depth === 0 && match[1] === '') {
      result += text.slice(last, match.index);
      depth = 1;
      openStart = match.index!;
    } else if (depth > 0 && match[1] === '') {
      depth += 1;
    } else if (depth > 0) {
      depth -= 1;
      if (depth === 0) {
        result += replacement;
        last = match.index! + match[0].length;
      }
    }
  }

  if (depth === 0) {
    return result + text.slice(last);
  }
  return failClosed ? result + replacement : result + text.slice(openStart);
}

function redactKnownValues(text: string): string {
  return knownSecretValues().reduce((acc, value) => acc.split(value).join(tagFor(value)), text);
}

function redactPatterns(text: string): string {
  return SECRET_PATTERNS.reduce((acc, pattern) => acc.replace(pattern, tagFor), text);
}

/**
 * Layer the maintained secretlint corpus (28 rules: Anthropic, OpenAI, GCP, Slack, private
 * keys, connection strings, and more) on top of the hand-rolled patterns above. secretlint's
 * `aws` rule only matches the secret-access-key shape — it walks past a bare `AKIA…` key ID —
 * so `SECRET_PATTERNS` runs first and stays; this is an added layer, not a replacement (#178).
 * `lintSource` returns character ranges into `text` (`String.prototype.slice` offsets, not
 * bytes), so masking is a substring replace against those ranges, not a second regex derivation.
 *
 * `ext: '.json'` is required for the `gcp` rule specifically — it is the only rule in the
 * preset that dispatches on `source.ext` (measured against the bundled preset source), and
 * without it a GCP service-account key never reports. Every other rule is unaffected by the
 * ext (measured: anthropic/github/etc. still fire); the gcp rule's own `JSON.parse` is inside
 * a try/catch, so non-JSON content just costs a caught throw, not a false positive.
 */
async function redactSecretlint(text: string): Promise<string> {
  const result = await lintSource({
    source: { content: text, filePath: 'event', ext: '.json', contentType: 'text' },
    options: {
      config: {
        rules: [
          {
            id: '@secretlint/secretlint-rule-preset-recommend',
            rule: secretlintPresetRecommend,
          },
        ],
      },
    },
  });

  if (result.messages.length === 0) {
    return text;
  }

  // Ranges are computed against the original text, so replacements are applied from the end
  // of the string backwards — replacing left-to-right would shift every range after the
  // first substitution.
  const ranges = [...result.messages].sort((a, b) => b.range[0] - a.range[0]);
  return ranges.reduce((acc, message) => {
    const [start, end] = message.range;
    return acc.slice(0, start) + tagFor(acc.slice(start, end)) + acc.slice(end);
  }, text);
}

async function redactWith(text: string, failClosedPrivate: boolean): Promise<string> {
  const withoutPrivate = stripTagBlocks(text, 'private', '[PRIVATE]', failClosedPrivate);
  const withoutMemory = stripTagBlocks(withoutPrivate, 'librarian-memory');
  const withoutKnownValues = redactKnownValues(withoutMemory);
  const withoutPatterns = redactPatterns(withoutKnownValues);
  return redactSecretlint(withoutPatterns);
}

/** Redact text a human authored (a prompt, a typed command). An unclosed `<private>` fails
 *  CLOSED — the user declared privacy and we honour the declaration over the content. */
export async function redact(text: string): Promise<string> {
  return redactWith(text, true);
}

/**
 * Redact text a machine produced (captured command output). Same secret patterns and same
 * memory-echo strip, but an unclosed `<private>` does NOT fail closed.
 *
 * Fail-closed encodes declared human intent. Machine output declares nothing: a stray
 * `<private>` in a test diff or a log line is an accident of the output, and truncating
 * everything after it would silently destroy the failure text on a log that is never
 * deleted — the exact knowledge this capture exists to keep. (This repo's own redact tests
 * print `<private>` in assertion diffs, so the case is not hypothetical.)
 */
export async function redactOutput(text: string): Promise<string> {
  return redactWith(text, false);
}
