const LIBRARIAN_BRIEF_PART = 'librarian-brief';
const LIBRARIAN_RECALL_PART = 'librarian-recall';

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
  librarian: typeof LIBRARIAN_BRIEF_PART | typeof LIBRARIAN_RECALL_PART;
};

function roleOf(message: OpenCodeMessage): string | undefined {
  return message.info?.role ?? message.role;
}

function isLibrarianPart(part: unknown): boolean {
  if (typeof part !== 'object' || part === null) return false;
  const rec = part as Record<string, unknown>;
  return rec.librarian === LIBRARIAN_BRIEF_PART || rec.librarian === LIBRARIAN_RECALL_PART;
}

function part(text: string, kind: TextPart['librarian']): TextPart {
  return { type: 'text', text, synthetic: true, librarian: kind };
}

export function spliceLibrarianInjection(
  messages: OpenCodeMessage[],
  recallBlock: string | undefined,
  briefBlock?: string | undefined,
): OpenCodeMessage[] {
  const brief = briefBlock && briefBlock.length > 0 ? briefBlock : undefined;
  const recall = recallBlock && recallBlock.length > 0 ? recallBlock : undefined;
  if (brief === undefined && recall === undefined && !messages.some((message) => (message.parts ?? []).some(isLibrarianPart))) {
    return messages;
  }

  const cleaned = messages.map((message) => ({
    ...message,
    parts: (message.parts ?? []).filter((candidate) => !isLibrarianPart(candidate)),
  }));
  if (brief === undefined && recall === undefined) return cleaned;

  const firstUser = cleaned.findIndex((message) => roleOf(message) === 'user');
  if (firstUser < 0) return cleaned;

  if (brief !== undefined) {
    cleaned[firstUser] = { ...cleaned[firstUser], parts: [part(brief, LIBRARIAN_BRIEF_PART), ...(cleaned[firstUser].parts ?? [])] };
  }
  if (recall !== undefined) {
    const latestUser = cleaned.findLastIndex((message) => roleOf(message) === 'user');
    cleaned[latestUser] = { ...cleaned[latestUser], parts: [part(recall, LIBRARIAN_RECALL_PART), ...(cleaned[latestUser].parts ?? [])] };
  }
  return cleaned;
}
