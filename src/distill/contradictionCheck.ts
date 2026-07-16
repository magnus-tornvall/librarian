import { readInjectionTraces } from '../diagnostics/injectionTrace.ts';
import { appendNote, readAllNotes } from '../log/noteLog.ts';
import { latestRecordPerNoteId, type NoteRecord, type NoteRevision, type NoteSupersession } from '../note.ts';
import { renderEventsForDistill } from '../render/distillPrompt.ts';
import { ulid } from 'ulid';
import type { InferenceProvider } from './provider.ts';

export type ContradictionVerdict = { contradicted: boolean; reason: string };

const INSTRUCTION = [
  'Decide whether the events explicitly correct the injected note.',
  'Default to NOT contradicted. Only an explicit, quotable user correction to the note content counts.',
  'Do not treat an unused, off-topic, incomplete, or merely discussed note as contradicted.',
  'Respond with ONLY this JSON object:',
  '  {"contradicted": boolean, "reason": string}',
].join('\n');

function unfence(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n?```$/);
  return match ? match[1].trim() : trimmed;
}

function parseVerdict(raw: string): ContradictionVerdict {
  const value: unknown = JSON.parse(unfence(raw));
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('contradiction response must be a JSON object');
  }
  const verdict = value as Record<string, unknown>;
  if (Object.keys(verdict).length !== 2 || typeof verdict.contradicted !== 'boolean' || typeof verdict.reason !== 'string') {
    throw new Error('contradiction response has an invalid verdict shape');
  }
  return { contradicted: verdict.contradicted, reason: verdict.reason };
}

export async function checkContradiction(
  note: NoteRevision,
  events: Array<Record<string, unknown>>,
  provider: InferenceProvider,
): Promise<ContradictionVerdict> {
  const judgment = JSON.stringify({ title: note.title, summary: note.body.summary, ...(note.body.bullets ? { bullets: note.body.bullets } : {}) });
  return parseVerdict(await provider.complete(`${INSTRUCTION}\n\nInjected note:\n${judgment}\n\nEvents:\n${renderEventsForDistill(events)}`));
}

export async function detectContradictions({
  dataDir,
  diagnosticsDir,
  sessionId,
  events,
  provider,
  report,
}: {
  dataDir: string;
  diagnosticsDir: string;
  sessionId: string;
  events: Array<Record<string, unknown>>;
  provider: InferenceProvider;
  report: (noteId: string, verdict: ContradictionVerdict, error?: string) => void;
}): Promise<number> {
  const firstTs = events[0]?.ts;
  const lastTs = events.at(-1)?.ts;
  if (typeof firstTs !== 'string' || typeof lastTs !== 'string') return 0;
  const noteIds = new Set(
    readInjectionTraces(diagnosticsDir)
      .filter((trace) => trace.session_id === sessionId && trace.ts >= firstTs && trace.ts <= lastTs)
      .flatMap((trace) => trace.shipped_note_ids),
  );
  if (noteIds.size === 0) return 0;

  const records = readAllNotes(dataDir) as NoteRecord[];
  const invalidated = new Set(records.filter((record): record is NoteSupersession => record.kind === 'note_supersession').map((record) => record.note_id));
  const notes = new Map(latestRecordPerNoteId(records).filter((record): record is NoteRevision => record.kind === 'note_revision').map((note) => [note.note_id, note]));
  let contradictions = 0;
  for (const noteId of noteIds) {
    const note = notes.get(noteId);
    if (!note || invalidated.has(noteId) || note.provenance.session_id === sessionId) continue;
    try {
      const verdict = await checkContradiction(note, events, provider);
      report(noteId, verdict);
      if (!verdict.contradicted) continue;
      appendNote(dataDir, {
        kind: 'note_supersession',
        schema_version: 1,
        note_id: noteId,
        revision_id: ulid(),
        created_at: new Date().toISOString(),
        reason: `${note.note_type === 'curated' || note.source.distiller === 'human' ? 'REVIEW REQUIRED: ' : ''}${verdict.reason}`,
        source: { kind: 'detector', session_id: sessionId },
      });
      contradictions += 1;
    } catch (err) {
      report(noteId, { contradicted: false, reason: 'detector failed' }, err instanceof Error ? err.message : String(err));
    }
  }
  return contradictions;
}
