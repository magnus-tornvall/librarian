import { ulid } from 'ulid';
import type { InferenceProvider } from './provider.ts';
import { renderEventsForDistill } from '../render/distillPrompt.ts';
import { latestRecordPerNoteId, type NoteRecord, type NoteRevision } from '../note.ts';
import { projectSlugFromGitRoot } from '../projectSlug.ts';

export type { NoteRevision };

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
  reason?: string;
  title?: string;
  summary?: string;
  bullets?: string[];
  links?: unknown;
};

const LINK_TARGET_TYPES = new Set<NoteRevision['links'][number]['target_type']>([
  'note',
  'entity',
  'project',
  'file',
  'url',
]);

// Chat providers (opencode/claude) sometimes wrap the object in a
// ```json ... ``` fence despite "ONLY JSON". Strip one fence if present;
// otherwise parse as-is so genuinely malformed JSON still throws.
function unfence(text: string): string {
  const trimmed = text.trim();
  const m = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n?```$/);
  return m ? m[1].trim() : trimmed;
}

function coerceNoteType(value: unknown): NoteRevision['note_type'] {
  return NOTE_TYPES.includes(value as NoteRevision['note_type'])
    ? (value as NoteRevision['note_type'])
    : 'episode';
}

const INSTRUCTION = [
  'You are distilling an agent session into one memory note.',
  'The verbatim event log is kept forever. Capture only what a future session could NOT cheaply re-derive from the repository or event log.',
  'Worth remembering:',
  '  decision: what was decided, why, and rejected alternatives',
  '  fact: hard-won facts not evident from reading the code',
  '  fact: user corrections or stated working preferences',
  '  project_summary: meaningful project-state changes',
  '  person: useful information about people',
  'NOT worth remembering: tools or commands run; files read or edited; routine narration such as "fixed the bug" or "ran the tests"; anything re-derivable by reading the repository; generic practices true of any project.',
  'Use absolute dates, never relative dates such as "today" or "recently".',
  'If nothing is worth remembering, respond exactly as {"note_type":"none","reason":"why nothing merits a note"}.',
  'Respond with ONLY a JSON object with these keys:',
  '  "note_type": one of fact | decision | project_summary | person | daily | episode | curated | none',
  '  "reason": required when note_type is none',
  '  "title": a short title',
  '  "summary": a one-to-two sentence summary',
  '  "bullets": (optional) an array of short strings',
  '  "links": (optional) an array of { "target_type": note | entity | project | file | url, "target": string, "relation": optional string }',
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
export type DistillJudgment = NoteRevision | { kind: 'declined'; reason: string };

export async function distill(
  events: Array<Record<string, unknown>>,
  sessionId: string,
  provider: InferenceProvider,
  origin: string,
  existingRecords: NoteRecord[] = [],
  feedback?: string,
): Promise<DistillJudgment> {
  const prompt = `${INSTRUCTION}${feedback ? `\nVerifier feedback: ${feedback}` : ''}\n\nEvents:\n${renderEventsForDistill(events)}`;
  const raw = await provider.complete(prompt);

  // Parse the LLM judgment. On malformed JSON, throw — no retry in this task
  // (§5 caps the eventual ceiling at completion + validate + one retry; the
  // retry-once wrapper is a later concern, per task 017's scope note).
  const judgment = JSON.parse(unfence(raw)) as LlmNoteJudgment;

  if (judgment.note_type === 'none') {
    return { kind: 'declined', reason: judgment.reason ?? '' };
  }

  const body: NoteRevision['body'] = { summary: judgment.summary ?? '' };
  if (Array.isArray(judgment.bullets)) {
    body.bullets = judgment.bullets;
  }

  const noteType = coerceNoteType(judgment.note_type);
  const resource = (events[0]?.resource ?? {}) as Record<string, unknown>;
  const gitRoot = typeof resource.git_root === 'string' ? resource.git_root : undefined;
  const gitRemote = typeof resource.git_remote === 'string' ? resource.git_remote : undefined;
  const projectSlug = projectSlugFromGitRoot(gitRoot);
  const deterministic = noteType === 'project_summary' && projectSlug !== undefined;
  const links = Array.isArray(judgment.links)
    ? judgment.links.filter((link): link is NoteRevision['links'][number] => {
        if (typeof link !== 'object' || link === null) return false;
        const candidate = link as Record<string, unknown>;
        return LINK_TARGET_TYPES.has(candidate.target_type as NoteRevision['links'][number]['target_type'])
          && typeof candidate.target === 'string'
          && candidate.target.length > 0
          && (candidate.relation === undefined || typeof candidate.relation === 'string');
      })
    : [];
  const firstEventId = events[0]?.event_id as string;
  const lastEventId = events.at(-1)?.event_id as string;
  const noteId = deterministic ? `project:${projectSlug}:summary` : `${noteType}:${ulid()}`;
  const previousRevision = deterministic
    ? latestRecordPerNoteId(existingRecords).find(
        (record): record is NoteRevision => record.kind === 'note_revision' && record.note_id === noteId,
      )
    : undefined;

  return {
    kind: 'note_revision',
    schema_version: 1,
    note_id: noteId,
    revision_id: ulid(),
    ...(previousRevision ? { previous_revision_id: previousRevision.revision_id } : {}),
    created_at: new Date().toISOString(),
    identity: deterministic
      ? { mode: 'deterministic', key: `project:${projectSlug}:summary` }
      : { mode: 'episodic' },
    source: { origin, distiller: 'llm', ...(provider.model ? { model: provider.model } : {}) },
    note_type: noteType,
    title: judgment.title ?? '',
    scope: projectSlug
      ? {
          project_slug: projectSlug,
          ...(gitRoot ? { git_root: gitRoot } : {}),
          ...(gitRemote ? { git_remote: gitRemote } : {}),
        }
      : { global: true },
    provenance: {
      session_id: sessionId,
      event_ids: events.map((event) => event.event_id as string),
      event_range: { from_event_id: firstEventId, to_event_id: lastEventId },
    },
    links,
    body,
  };
}
