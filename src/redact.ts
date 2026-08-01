import { createHash } from 'node:crypto';

const SECRET_PATTERNS: RegExp[] = [
  /AKIA[0-9A-Z]{16}/g,
  /\b(?:token|api[_-]?key|secret)\b["']?[=: ]+["']?[A-Za-z0-9_\-.]{16,}/gi,
  /ghp_[A-Za-z0-9]{36}/g,
];

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

function redactWith(text: string, failClosedPrivate: boolean): string {
  const withoutPrivate = stripTagBlocks(text, 'private', '[PRIVATE]', failClosedPrivate);
  const withoutMemory = stripTagBlocks(withoutPrivate, 'librarian-memory');
  return SECRET_PATTERNS.reduce((acc, pattern) => acc.replace(pattern, tagFor), withoutMemory);
}

/** Redact text a human authored (a prompt, a typed command). An unclosed `<private>` fails
 *  CLOSED — the user declared privacy and we honour the declaration over the content. */
export function redact(text: string): string {
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
export function redactOutput(text: string): string {
  return redactWith(text, false);
}
