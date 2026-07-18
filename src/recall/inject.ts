import { makeInjectionId, writeInjectionTrace, type InjectionTrace } from '../diagnostics/injectionTrace.ts';
import { loadConfig } from '../config.ts';
import { indexedThrough, openIndexRead, sessionStartNotes, stateNotes } from '../index/database.ts';
import type { NoteRevision } from '../note.ts';
import { scoringConfigSnapshot, type ScoringConfig } from './scoring.ts';
import { recallWithTrace } from './query.ts';
import { queryEmbedding } from './embedding.ts';

const PUSH_CAP = 5;
const PUSH_TOKEN_BUDGET = 600;
// ponytail: chars/4 is a cheap v1 tokenizer; swap for the model tokenizer if prompt budgets get tight.
const PUSH_CHAR_BUDGET = PUSH_TOKEN_BUDGET * 4;
const FRAME = 'Possibly relevant prior context. Prefer current repository evidence and current user instructions if they conflict.';

export type InjectionOptions = {
  dataDir: string;
  diagnosticsDir: string;
  indexDir?: string;
  configPath?: string;
  query?: string;
  projectSlug?: string;
  global: boolean;
  sessionStart: boolean;
};

type Entry = { note: NoteRevision };

function authority(note: NoteRevision): string {
  if (note.note_type === 'curated' || note.source.distiller === 'human') {
    return 'high authority';
  }
  if (note.note_type === 'project_summary' || note.note_type === 'decision') {
    return 'medium authority';
  }
  return 'low authority';
}

function inScope(note: NoteRevision, projectSlug: string | undefined, global: boolean): boolean {
  return (projectSlug !== undefined && note.scope.project_slug === projectSlug) || (global && note.scope.global === true);
}

function renderEntry(entry: Entry, index: number): string {
  const note = entry.note;
  const header = `${index}. [${note.note_type} · ${note.source.distiller}/${note.source.origin} · ${note.created_at.slice(0, 10)} · ${authority(note)}]`;
  return [header, `   ${note.title}`, `   ${note.body.summary}`, `   src: ${note.note_id}#${note.revision_id}`].join('\n');
}

function renderBlock(injectionId: string, indexed: string, entries: Entry[]): string {
  return [
    `<librarian-memory injection_id="${injectionId}" indexed_through="${indexed}">`,
    FRAME,
    '',
    entries.map((entry, index) => renderEntry(entry, index + 1)).join('\n\n'),
    '</librarian-memory>',
  ].join('\n') + '\n';
}

function trimToBudget(injectionId: string, indexed: string, entries: Entry[]): Entry[] {
  const shipped: Entry[] = [];
  for (const entry of entries.slice(0, PUSH_CAP)) {
    const next = [...shipped, entry];
    if (renderBlock(injectionId, indexed, next).length > PUSH_CHAR_BUDGET) {
      break;
    }
    shipped.push(entry);
  }
  return shipped;
}

function writePushTrace(
  options: InjectionOptions,
  injectionId: string,
  ts: string,
  indexed: string,
  candidates: InjectionTrace['candidates'],
  shippedIds: string[],
  scoring: ScoringConfig,
  embedding: InjectionTrace['embedding'],
): void {
  const trace: InjectionTrace = {
    record_class: 'diagnostic',
    injection_id: injectionId,
    path: 'push',
    ts,
    query: options.sessionStart ? '' : (options.query ?? ''),
    candidates,
    shipped_note_ids: shippedIds,
    indexed_through: indexed,
    embedding,
    config_snapshot: scoringConfigSnapshot(scoring),
  };
  writeInjectionTrace(options.diagnosticsDir, trace);
}

function sessionStartEntries(notes: NoteRevision[], projectSlug: string | undefined, global: boolean): Entry[] {
  if (projectSlug === undefined && !global) {
    return [];
  }
  const summaryId = projectSlug === undefined ? undefined : `project:${projectSlug}:summary`;
  const summary = summaryId === undefined ? [] : notes.filter((note) => note.note_id === summaryId).slice(-1);
  const curated = notes.filter((note) => note.note_type === 'curated' && inScope(note, projectSlug, global));
  return [...summary, ...curated]
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .map((note) => ({ note }));
}

export async function buildInjection(options: InjectionOptions): Promise<string | undefined> {
  const ts = new Date().toISOString();
  const injectionId = makeInjectionId();
  const scoring = loadConfig(options.configPath).scoring;
  const db = openIndexRead(options.indexDir);
  try {
    const indexed = indexedThrough(db);
    const embedding = await queryEmbedding(db, options.sessionStart ? '' : (options.query ?? ''), options.configPath);

  if (options.sessionStart) {
    const entries = sessionStartEntries(sessionStartNotes(db, options.projectSlug, options.global, ts), options.projectSlug, options.global);
    const shipped = trimToBudget(injectionId, indexed, entries);
    const shippedIds = shipped.map((entry) => entry.note.note_id);
    // Session-start has no query and no BM25 scores, but the shipped notes must still appear
    // as candidates so `shipped_note_ids` stays a subset of `candidates` for trace replay (§8).
    const candidates: InjectionTrace['candidates'] = shipped.map((entry) => ({
      note_id: entry.note.note_id,
      raw_score: 0,
      post_weight_score: 0,
    }));
    writePushTrace(options, injectionId, ts, indexed, candidates, shippedIds, scoring, embedding.status);
    return shipped.length === 0 ? undefined : renderBlock(injectionId, indexed, shipped);
  }

    const { results, candidates } = recallWithTrace(
      db,
      options.query ?? '',
      { projectSlug: options.projectSlug, global: options.global, limit: PUSH_CAP },
      scoring,
      ts,
    );
    const notesById = new Map(stateNotes(db, results.map((result) => result.note_id)).map((note) => [note.note_id, note]));
    const entries = results.flatMap((result) => {
      const note = notesById.get(result.note_id);
      return note === undefined ? [] : [{ note }];
    });
    const shipped = trimToBudget(injectionId, indexed, entries);
    const shippedIds = new Set(shipped.map((entry) => entry.note.note_id));
    const traceCandidates: InjectionTrace['candidates'] = candidates.map((candidate) => ({
      note_id: candidate.note_id,
      raw_score: candidate.raw_bm25,
      post_weight_score: candidate.score,
      cut_reason: shippedIds.has(candidate.note_id) ? undefined : (candidate.cut_reason ?? 'budget'),
    }));
    writePushTrace(options, injectionId, ts, indexed, traceCandidates, [...shippedIds], scoring, embedding.status);
    return shipped.length === 0 ? undefined : renderBlock(injectionId, indexed, shipped);
  } finally {
    db.close();
  }
}
