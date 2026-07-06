import { ulid } from 'ulid';
import type { InferenceProvider } from './provider.ts';
import { renderEventsForDistill } from '../render/distillPrompt.ts';
import type { NoteRevision } from '../note.ts';

export type { NoteRevision };

// This path only ever mints EPISODIC notes: `note_id = {note_type}:{ulid}` per spec §5/§10.2,
// one immutable revision.

const NOTE_TYPES: ReadonlyArray<NoteRevision['note_type']> = [
  'fact',
  'decision',
  'project_summary',
  'person',
  'daily',
  'episode',
  'curated',
];

type LlmNoteJudgment = {
  note_type?: string;
  title?: string;
  summary?: string;
  bullets?: string[];
};

function coerceNoteType(value: unknown): NoteRevision['note_type'] {
  return NOTE_TYPES.includes(value as NoteRevision['note_type'])
    ? (value as NoteRevision['note_type'])
    : 'episode';
}

const INSTRUCTION = [
  'You are distilling an agent session into one memory note.',
  'Read the indexed event lines below and decide what is worth remembering.',
  'Respond with ONLY a JSON object with these keys:',
  '  "note_type": one of fact | decision | project_summary | person | daily | episode | curated',
  '  "title": a short title',
  '  "summary": a one-to-two sentence summary',
  '  "bullets": (optional) an array of short strings',
  '',
  'Events:',
].join('\n');

/**
 * Distill an ordered event range into a `NoteRevision` (§4, roadmap item 4).
 *
 * The LLM does *judgment* (worth-remembering / type / title / summary); the code
 * does *identity and provenance*. `note_id`, `revision_id`, `created_at`,
 * `identity`, `source`, and `provenance` are stamped MECHANICALLY here — the
 * LLM's response never dictates them. Provenance `event_ids` are read straight
 * off the input events, not cited by the model. No live call: the provider is
 * injected (tests pass `makeFixtureProvider`).
 *
 * `note_id`/`revision_id` use the `ulid` package (monotonic within a
 * millisecond, so the two ids minted back-to-back here sort in creation order).
 */
export async function distill(
  events: Array<Record<string, unknown>>,
  sessionId: string,
  provider: InferenceProvider,
  origin: string,
): Promise<NoteRevision> {
  const prompt = `${INSTRUCTION}\n${renderEventsForDistill(events)}`;
  const raw = await provider.complete(prompt);

  // Parse the LLM judgment. On malformed JSON, throw — no retry in this task
  // (§5 caps the eventual ceiling at completion + validate + one retry; the
  // retry-once wrapper is a later concern, per task 017's scope note).
  const judgment = JSON.parse(raw) as LlmNoteJudgment;

  const body: NoteRevision['body'] = { summary: judgment.summary ?? '' };
  if (Array.isArray(judgment.bullets)) {
    body.bullets = judgment.bullets;
  }

  const noteType = coerceNoteType(judgment.note_type);

  return {
    kind: 'note_revision',
    schema_version: 1,
    note_id: `${noteType}:${ulid()}`,
    revision_id: ulid(),
    created_at: new Date().toISOString(),
    identity: { mode: 'episodic' },
    source: { origin, distiller: 'llm' },
    note_type: noteType,
    title: judgment.title ?? '',
    scope: {},
    provenance: {
      session_id: sessionId,
      event_ids: events.map((event) => event.event_id as string),
    },
    links: [],
    body,
  };
}
