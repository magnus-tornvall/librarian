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

  for (const match of text.matchAll(marker)) {
    if (depth === 0 && match[1] === '') {
      result += text.slice(last, match.index) + replacement;
      depth = 1;
      openStart = match.index!;
    } else if (depth > 0 && match[1] === '') {
      depth += 1;
    } else if (depth > 0) {
      depth -= 1;
      if (depth === 0) last = match.index! + match[0].length;
    }
  }

  return depth > 0 && failClosed ? result : result + text.slice(depth > 0 ? openStart : last);
}

export function redact(text: string): string {
  const withoutPrivate = stripTagBlocks(text, 'private', '[PRIVATE]', true);
  const withoutMemory = stripTagBlocks(withoutPrivate, 'librarian-memory');
  return SECRET_PATTERNS.reduce((acc, pattern) => acc.replace(pattern, tagFor), withoutMemory);
}
