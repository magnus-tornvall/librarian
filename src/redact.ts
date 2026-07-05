import { createHash } from 'node:crypto';

const SECRET_PATTERNS: RegExp[] = [
  /AKIA[0-9A-Z]{16}/g,
  /(?:token|api[_-]?key|secret)[=: ]+["']?[A-Za-z0-9_\-.]{16,}/gi,
  /ghp_[A-Za-z0-9]{36}/g,
];

function tagFor(secret: string): string {
  const hash = createHash('sha256').update(secret).digest('hex').slice(0, 8);
  return `[REDACTED:token:sha256:${hash}]`;
}

export function redact(text: string): string {
  return SECRET_PATTERNS.reduce((acc, pattern) => acc.replace(pattern, tagFor), text);
}
