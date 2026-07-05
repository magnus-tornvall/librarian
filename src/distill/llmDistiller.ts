import { ulid } from 'ulid';
import type { InferenceProvider } from './provider.ts';
import { renderEventsForDistill } from '../render/distillPrompt.ts';

/**
 * `NoteRevision` per spec §10.2 (task 005's module is a soft dep — the spec
 * shape is the fallback source until it merges). This path only ever mints
 * EPISODIC notes: `note_id = {origin}:{ulid}`, one immutable revision.
 */
export type NoteRevision = {
  kind: 'note_revision';
  schema_version: 1;
  note_id: string;
  revision_id: string;
  previous_revision_id?: string;
  created_at: string;
  identity: { mode: 'deterministic' | 'episodic'; key?: string };
  source: {
    origin: string;
    distiller: 'llm' | 'human';
    model?: string;
    agent?: string;
    source_path?: string;
    content_hash?: string;
  };
  note_type: 'fact' | 'decision' | 'project_summary' | 'person' | 'daily' | 'episode' | 'curated';
  title: string;
  scope: { project_slug?: string; git_root?: string; git_remote?: string; global?: boolean };
  provenance: {
    session_id?: string;
    event_ids?: string[];
    event_range?: { from_event_id: string; to_event_id: string };
  };
  links: Array<{
    target_type: 'note' | 'entity' | 'project' | 'file' | 'url';
    target: string;
    relation?: string;
  }>;
  body: { summary: string; bullets?: string[]; details?: string };
};

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

  return {
    kind: 'note_revision',
    schema_version: 1,
    note_id: `${origin}:${ulid()}`,
    revision_id: ulid(),
    created_at: new Date().toISOString(),
    identity: { mode: 'episodic' },
    source: { origin, distiller: 'llm' },
    note_type: coerceNoteType(judgment.note_type),
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
