import type { NoteRevision } from '../note.ts';
import { renderEventsForDistill } from '../render/distillPrompt.ts';
import type { InferenceProvider } from './provider.ts';

export type VerifyVerdict = {
  faithful: boolean;
  errors: Array<'omission' | 'corruption' | 'hallucination'>;
  reason: string;
};

const ERROR_TYPES = new Set<VerifyVerdict['errors'][number]>([
  'omission',
  'corruption',
  'hallucination',
]);

const INSTRUCTION = [
  'Check whether the note is faithful to the source events.',
  'The verifier vetoes unfaithful notes and must never rewrite them.',
  'Respond with ONLY this JSON object:',
  '  {"faithful": boolean, "errors": ["omission"|"corruption"|"hallucination"], "reason": string}',
  '',
  'Note judgment fields:',
].join('\n');

function unfence(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n?```$/);
  return match ? match[1].trim() : trimmed;
}

function parseVerdict(raw: string): VerifyVerdict {
  const value: unknown = JSON.parse(unfence(raw));
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('verifier response must be a JSON object');
  }
  const verdict = value as Record<string, unknown>;
  if (
    typeof verdict.faithful !== 'boolean' ||
    !Array.isArray(verdict.errors) ||
    !verdict.errors.every((error) => typeof error === 'string' && ERROR_TYPES.has(error as VerifyVerdict['errors'][number])) ||
    typeof verdict.reason !== 'string'
  ) {
    throw new Error('verifier response has an invalid verdict shape');
  }
  return { faithful: verdict.faithful, errors: verdict.errors as VerifyVerdict['errors'], reason: verdict.reason };
}

/** Verify only LLM-authored judgment fields against the same rendered source events. */
export async function verifyNote(
  note: NoteRevision,
  events: Array<Record<string, unknown>>,
  provider: InferenceProvider,
): Promise<VerifyVerdict> {
  const judgment = JSON.stringify({
    title: note.title,
    summary: note.body.summary,
    ...(note.body.bullets ? { bullets: note.body.bullets } : {}),
    links: note.links,
  });
  const prompt = `${INSTRUCTION}\n${judgment}\n\nEvents:\n${renderEventsForDistill(events)}`;
  return parseVerdict(await provider.complete(prompt));
}
