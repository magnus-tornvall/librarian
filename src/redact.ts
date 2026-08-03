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
// token, a plain password) is still caught by what it IS, not what it looks like. Scoped to
// credential-named env vars, not every env var — matching on name keeps a long but ordinary
// value (PATH, npm_config_user_agent) from being flagged as a secret by coincidence.
const CREDENTIAL_ENV_NAME = /token|api[_-]?key|secret|password|passwd|credential|auth/i;

function knownSecretValues(): string[] {
  return Object.entries(process.env)
    .filter(([name, value]) => CREDENTIAL_ENV_NAME.test(name) && typeof value === 'string' && value.length >= 8)
    .map(([, value]) => value as string);
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
 * `lintSource` returns byte ranges into `text`, so masking is a substring replace against
 * those ranges, not a second regex derivation.
 */
async function redactSecretlint(text: string): Promise<string> {
  const result = await lintSource({
    source: { content: text, filePath: 'event', contentType: 'text' },
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
