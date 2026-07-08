const LIBRARIAN_PART = 'librarian-recall';

export type OpenCodeMessage = {
  info?: { role?: string };
  role?: string;
  parts?: unknown[];
  [key: string]: unknown;
};

type TextPart = {
  type: 'text';
  text: string;
  synthetic: true;
  librarian: typeof LIBRARIAN_PART;
};

function roleOf(message: OpenCodeMessage): string | undefined {
  return message.info?.role ?? message.role;
}

function isLibrarianPart(part: unknown): boolean {
  if (typeof part !== 'object' || part === null) return false;
  const rec = part as Record<string, unknown>;
  return rec.librarian === LIBRARIAN_PART || (rec.type === 'text' && typeof rec.text === 'string' && rec.text.includes('<librarian-memory'));
}

function part(text: string): TextPart {
  return { type: 'text', text, synthetic: true, librarian: LIBRARIAN_PART };
}

function joined(briefBlock: string | undefined, recallBlock: string | undefined): string | undefined {
  const blocks = [briefBlock, recallBlock].filter((block): block is string => block !== undefined && block.length > 0);
  return blocks.length > 0 ? blocks.join('\n') : undefined;
}

export function spliceLibrarianInjection(
  messages: OpenCodeMessage[],
  recallBlock: string | undefined,
  briefBlock?: string | undefined,
): OpenCodeMessage[] {
  const text = joined(briefBlock, recallBlock);
  if (text === undefined && !messages.some((message) => (message.parts ?? []).some(isLibrarianPart))) {
    return messages;
  }

  const cleaned = messages.map((message) => ({
    ...message,
    parts: (message.parts ?? []).filter((candidate) => !isLibrarianPart(candidate)),
  }));
  if (text === undefined) return cleaned;

  const firstUser = cleaned.findIndex((message) => roleOf(message) === 'user');
  if (firstUser < 0) return cleaned;

  const target = briefBlock ? firstUser : cleaned.findLastIndex((message) => roleOf(message) === 'user');
  cleaned[target] = { ...cleaned[target], parts: [part(text), ...(cleaned[target].parts ?? [])] };
  return cleaned;
}
