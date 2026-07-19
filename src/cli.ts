#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { ulid } from 'ulid';
import { appendEvent } from './collector/append.ts';
import { makeInjectionId, readInjectionTraces, writeInjectionTrace, type InjectionTrace } from './diagnostics/injectionTrace.ts';
import { readDistillVerdicts } from './diagnostics/distillVerdict.ts';
import { computeStats, formatStats } from './diagnostics/stats.ts';
import { makeFixtureProvider, makeScriptedFixtureProvider, type InferenceProvider } from './distill/provider.ts';
import { makeClaudeProvider } from './distill/claudeProvider.ts';
import { makeOpencodeProvider } from './distill/opencodeProvider.ts';
import { importCuratedNote } from './distill/humanDistiller.ts';
import { loadConfig } from './config.ts';
import { embeddingCoverage, embeddingIndexModel, indexedThrough, openIndexRead, openIndexWrite, stateNotes } from './index/database.ts';
import { makeOpenAiEmbeddingProvider } from './embedding/provider.ts';
import { runDistill } from './distill/distillRun.ts';
import { runExport } from './export/exportRun.ts';
import { readAll } from './log/ndjson.ts';
import { appendNote, readAllNotes } from './log/noteLog.ts';
import { buildFlagRecord, latestRecordPerNoteId, type NoteFlag, type NoteRecord, type NoteRevision, type NoteStateRecord, type NoteSupersession, type NoteTombstone } from './note.ts';
import { CONFIG_PATH, DATA_DIR, DIAGNOSTICS_DIR, INDEX_DIR, MACHINE_ID_PATH } from './paths.ts';
import { scoringConfigSnapshot, type ScoringConfig } from './recall/scoring.ts';
import { buildInjection, type InjectionOptions } from './recall/inject.ts';
import { recallWithTrace, whyNot, type RecallTraceCandidate, type WhyNotResult } from './recall/query.ts';
import { queryEmbedding, updateIndex, type QueryEmbedding } from './recall/embedding.ts';

/**
 * `librarian` CLI — a thin shell over the collector library (spec §4: collector
 * is "library + CLI, no daemon"). It processes stdin and exits; it adds no
 * second validation or redaction layer — redact → validate → append all live in
 * `appendEvent`.
 */

const USAGE = `usage:
  librarian collect [--data-dir <dir>]     read canonical-event NDJSON on stdin
  librarian distill [--data-dir <dir>] [--index-dir <dir>] [--diagnostics-dir <dir>] [--provider <claude|opencode>] [--model <provider/model>] [--provider-fixture <file>]
                                           distill pending event deltas into notes
  librarian drain [--data-dir <dir>] [--index-dir <dir>] [--diagnostics-dir <dir>] [--vault <dir>] [--provider <claude|opencode>] [--model <provider/model>] [--provider-fixture <file>]
                                           process everything pending: distill, then export to a vault
  librarian recall <query> --project <slug> [--index-dir <dir>] [--global] [--origin <origin>] [--limit N] [--json]
                                           search the recall index for pull-path results
  librarian why (<injection_id> | --last [--session <id>]) [--json]
                                           explain a diagnostics injection trace (--last: newest push trace)
  librarian why-not <query> <note_id> --project <slug> [--index-dir <dir>] [--global]
                                            explain why a note did not ship for a query
  librarian why-summary [--session <id>] [--diagnostics-dir <dir>] [--json]
                                            replay a session's push-path injection traces in order
  librarian stats [--index-dir <dir>] [--config <file>] [--json]
                                            report admission, usage, cut reasons, and index embedding coverage
  librarian doctor [--index-dir <dir>] [--config <file>] [--json]
                                            report embedding endpoint and index readiness
  librarian inject --project <slug> [--index-dir <dir>] [--global] [--session-start] [--session <id>]
                                           read prompt text on stdin and print push-path memory block
  librarian note show <note_id> [--data-dir <dir>] [--with-provenance] [--json]
                                              print a note, optionally with source provenance
  librarian note import-curated <file> --vault <dir> [--data-dir <dir>] [--index-dir <dir>]
                                              import a curated Markdown note
  librarian note tombstone <note_id> [--data-dir <dir>] [--index-dir <dir>] [--reason <text>]
                                               tombstone the latest note revision
  librarian supersede <old_note_id> <new_note_id> [--data-dir <dir>] [--index-dir <dir>] [--reason <text>]
                                               append an annotation invalidating an old note for recall
  librarian flag <note_id> --reason <text> [--data-dir <dir>] [--index-dir <dir>]
                                               flag a note as wrong (validity-close, no replacement) so recall excludes it
  librarian mcp [--data-dir <dir>] [--index-dir <dir>] [--diagnostics-dir <dir>]
                                           start the MCP stdio server
  librarian machine-id [--path <file>]     print the persisted machine id
`;

const PULL_RECALL_DEFAULT_LIMIT = 10;
const PULL_RECALL_LIMIT_CEILING = 10;

/** Minimal `--flag value` parser — no CLI framework dependency (§14). */
function parseFlags(argv: string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      throw new Error(`unexpected argument: ${arg}`);
    }
    const value = argv[i + 1];
    if (value === undefined) {
      throw new Error(`flag ${arg} requires a value`);
    }
    flags.set(arg.slice(2), value);
    i += 1;
  }
  return flags;
}

function parseInjectArgs(argv: string[]): InjectionOptions {
  const options: InjectionOptions = {
    dataDir: DATA_DIR,
    diagnosticsDir: DIAGNOSTICS_DIR,
    indexDir: INDEX_DIR,
    global: false,
    sessionStart: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--global') {
      options.global = true;
    } else if (arg === '--session-start') {
      options.sessionStart = true;
    } else if (arg === '--session') {
      const value = argv[i + 1];
      if (value === undefined) {
        throw new Error('flag --session requires a value');
      }
      options.sessionId = value;
      i += 1;
    } else if (arg === '--project') {
      const value = argv[i + 1];
      if (value === undefined) {
        throw new Error('flag --project requires a value');
      }
      options.projectSlug = value;
      i += 1;
    } else if (arg === '--data-dir') {
      const value = argv[i + 1];
      if (value === undefined) {
        throw new Error('flag --data-dir requires a value');
      }
      options.dataDir = value;
      i += 1;
    } else if (arg === '--diagnostics-dir') {
      const value = argv[i + 1];
      if (value === undefined) {
        throw new Error('flag --diagnostics-dir requires a value');
      }
      options.diagnosticsDir = value;
      i += 1;
    } else if (arg === '--index-dir') {
      const value = argv[i + 1];
      if (value === undefined) throw new Error('flag --index-dir requires a value');
      options.indexDir = value;
      i += 1;
    } else if (arg === '--config') {
      const value = argv[i + 1];
      if (value === undefined) throw new Error('flag --config requires a value');
      options.configPath = value;
      i += 1;
    } else {
      throw new Error(`unexpected argument: ${arg}`);
    }
  }
  return options;
}

type NoteShowOptions = { noteId: string; dataDir: string; withProvenance: boolean; json: boolean };

async function noteImportCurated(argv: string[]): Promise<void> {
  const [file, ...rest] = argv;
  if (!file || file.startsWith('--')) throw new Error('note import-curated requires <file>');
  const flags = parseFlags(rest);
  const vault = flags.get('vault');
  if (!vault) throw new Error('note import-curated requires --vault <dir>');
  const dataDir = flags.get('data-dir') ?? DATA_DIR;
  const note = importCuratedNote(vault, file, dataDir);
  await updateIndex(flags.get('index-dir') ?? INDEX_DIR, dataDir, flags.get('config'));
  process.stdout.write(JSON.stringify(note) + '\n');
}

async function noteTombstone(argv: string[]): Promise<void> {
  const [noteId, ...rest] = argv;
  if (!noteId || noteId.startsWith('--')) throw new Error('note tombstone requires <note_id>');
  const flags = parseFlags(rest);
  const dataDir = flags.get('data-dir') ?? DATA_DIR;
  const latest = findLatestNote(dataDir, noteId);
  if (!latest) throw new Error(`unknown note_id: ${noteId}`);
  if (latest.kind === 'note_tombstone') {
    process.stdout.write(JSON.stringify(latest) + '\n');
    return;
  }
  const tombstone: NoteTombstone = {
    kind: 'note_tombstone', schema_version: 1, note_id: noteId, revision_id: ulid(),
    previous_revision_id: latest.revision_id, reason: flags.get('reason') ?? 'tombstoned by CLI',
    created_at: new Date().toISOString(), source: { kind: 'cli' },
  };
  appendNote(dataDir, tombstone);
  await updateIndex(flags.get('index-dir') ?? INDEX_DIR, dataDir, flags.get('config'));
  process.stdout.write(JSON.stringify(tombstone) + '\n');
}

async function supersede(argv: string[]): Promise<void> {
  const [oldNoteId, newNoteId, ...rest] = argv;
  if (!oldNoteId || oldNoteId.startsWith('--') || !newNoteId || newNoteId.startsWith('--')) {
    throw new Error('supersede requires <old_note_id> <new_note_id>');
  }
  const flags = parseFlags(rest);
  const dataDir = flags.get('data-dir') ?? DATA_DIR;
  if (!findLatestNote(dataDir, oldNoteId)) throw new Error(`unknown note_id: ${oldNoteId}`);
  if (!findLatestNote(dataDir, newNoteId)) throw new Error(`unknown note_id: ${newNoteId}`);
  const record: NoteSupersession = {
    kind: 'note_supersession', schema_version: 1, note_id: oldNoteId, superseded_by: newNoteId,
    revision_id: ulid(), created_at: new Date().toISOString(), reason: flags.get('reason'), source: { kind: 'cli' },
  };
  appendNote(dataDir, record);
  await updateIndex(flags.get('index-dir') ?? INDEX_DIR, dataDir, flags.get('config'));
  process.stdout.write(JSON.stringify(record) + '\n');
}

async function flagNote(argv: string[]): Promise<void> {
  const [noteId, ...rest] = argv;
  if (!noteId || noteId.startsWith('--')) throw new Error('flag requires <note_id>');
  const flags = parseFlags(rest);
  const reason = flags.get('reason');
  if (!reason) throw new Error('flag requires --reason <text>');
  const dataDir = flags.get('data-dir') ?? DATA_DIR;
  const record = await flagNoteRecord(dataDir, flags.get('index-dir') ?? INDEX_DIR, noteId, reason, { kind: 'cli' }, flags.get('config'));
  process.stdout.write(JSON.stringify(record) + '\n');
}

/** Append a validity-close-only flag and run indexer catch-up (#106). Shared by CLI and MCP. */
export async function flagNoteRecord(
  dataDir: string,
  indexDir: string,
  noteId: string,
  reason: string,
  source: { kind: 'human' | 'cli' },
  configPath?: string,
): Promise<NoteFlag> {
  if (!findLatestNote(dataDir, noteId)) throw new Error(`unknown note_id: ${noteId}`);
  const record = buildFlagRecord(noteId, reason, source);
  appendNote(dataDir, record);
  await syncIndex(dataDir, indexDir, configPath);
  return record;
}

export type RecallOptions = {
  query: string;
  projectSlug?: string;
  global: boolean;
  origin?: string;
  limit: number;
  json: boolean;
  dataDir: string;
  diagnosticsDir: string;
  indexDir?: string;
  configPath?: string;
};

export type RecallResult = {
  note_id: string;
  title: string;
  summary: string;
  note_type: string;
  origin: string;
  created_at: string;
  project_slug: string;
  is_global: boolean;
  score: number;
};

export type RecallPayload = { results: RecallResult[]; message?: string };

export type NoteShowPayload = { note: NoteStateRecord; provenance_events: Array<Record<string, unknown>> | null };

type WhyOptions = { injectionId?: string; last?: boolean; sessionId?: string; json: boolean; diagnosticsDir: string };
type WhySummaryOptions = { session?: string; json: boolean; diagnosticsDir: string };
type WhyNotOptions = { query: string; noteId: string; projectSlug?: string; global: boolean; dataDir: string; indexDir: string };

function statsCommand(argv: string[]): void {
  let json = false;
  let dataDir = DATA_DIR;
  let diagnosticsDir = DIAGNOSTICS_DIR;
  let indexDir = INDEX_DIR;
  let configPath = CONFIG_PATH;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') json = true;
    else if (arg === '--data-dir' || arg === '--diagnostics-dir' || arg === '--index-dir' || arg === '--config') {
      const value = argv[++i];
      if (value === undefined) throw new Error(`flag ${arg} requires a value`);
      if (arg === '--data-dir') dataDir = value;
      else if (arg === '--diagnostics-dir') diagnosticsDir = value;
      else if (arg === '--index-dir') indexDir = value;
      else configPath = value;
    } else throw new Error(`unexpected argument: ${arg}`);
  }
  const notes = latestRecordPerNoteId(readAllNotes(dataDir) as NoteRecord[])
    .filter((record): record is NoteRevision => record.kind === 'note_revision')
    .map(({ note_id, title, created_at }) => ({ note_id, title, created_at }));
  const report = computeStats({
    verdicts: readDistillVerdicts(diagnosticsDir),
    traces: readInjectionTraces(diagnosticsDir),
    notes,
    now: new Date(),
  });
  try {
    const db = openIndexRead(indexDir);
    try { report.index = { embedding: embeddingCoverage(db, loadConfig(configPath).embedding !== undefined) }; } finally { db.close(); }
  } catch {
    // A missing index is normal before the first drain; diagnostics remain useful.
  }
  process.stdout.write(json ? JSON.stringify(report) + '\n' : formatStats(report));
}

export type DoctorReport = {
  embedding: {
    state: 'unconfigured' | 'unreachable' | 'unpinned' | 'mismatch' | 'ok';
    model?: string;
    digest?: string;
    index_model?: string;
    index_digest?: string;
    error?: string;
  };
  coverage: { embedded: number; total: number };
  indexed_through: string;
  index_error?: string;
};

export async function doctorReport(indexDir = INDEX_DIR, configPath = CONFIG_PATH): Promise<DoctorReport> {
  const config = loadConfig(configPath);
  let db: ReturnType<typeof openIndexRead> | undefined;
  let coverage = { embedded: 0, total: 0 };
  let indexed = '';
  let model: ReturnType<typeof embeddingIndexModel> = undefined;
  let indexError: string | undefined;
  try {
    db = openIndexRead(indexDir);
    coverage = embeddingCoverage(db, config.embedding !== undefined);
    indexed = indexedThrough(db);
    model = embeddingIndexModel(db);
  } catch (error) {
    indexError = error instanceof Error ? error.message : String(error);
  } finally {
    db?.close();
  }
  if (!config.embedding) {
    return { embedding: { state: 'unconfigured', ...(model ? { index_model: model.name, index_digest: model.digest } : {}) }, coverage, indexed_through: indexed, ...(indexError ? { index_error: indexError } : {}) };
  }
  try {
    const resolved = await makeOpenAiEmbeddingProvider(config.embedding).model();
    if (!model) {
      return { embedding: { state: 'unpinned', model: resolved.name, digest: resolved.digest }, coverage, indexed_through: indexed, ...(indexError ? { index_error: indexError } : {}) };
    }
    if (model && (model.name !== resolved.name || model.digest !== resolved.digest)) {
      return { embedding: { state: 'mismatch', model: resolved.name, digest: resolved.digest, index_model: model.name, index_digest: model.digest }, coverage, indexed_through: indexed, ...(indexError ? { index_error: indexError } : {}) };
    }
    return { embedding: { state: 'ok', model: resolved.name, digest: resolved.digest, ...(model ? { index_model: model.name, index_digest: model.digest } : {}) }, coverage, indexed_through: indexed, ...(indexError ? { index_error: indexError } : {}) };
  } catch (error) {
    return { embedding: { state: 'unreachable', model: config.embedding.model, error: error instanceof Error ? error.message : String(error) }, coverage, indexed_through: indexed, ...(indexError ? { index_error: indexError } : {}) };
  }
}

async function doctorCommand(argv: string[]): Promise<void> {
  let indexDir = INDEX_DIR;
  let configPath = CONFIG_PATH;
  let json = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') json = true;
    else if (arg === '--index-dir' || arg === '--config') {
      const value = argv[++i];
      if (value === undefined) throw new Error(`flag ${arg} requires a value`);
      if (arg === '--index-dir') indexDir = value;
      else configPath = value;
    } else throw new Error(`unexpected argument: ${arg}`);
  }
  const report = await doctorReport(indexDir, configPath);
  if (json) {
    process.stdout.write(JSON.stringify(report) + '\n');
    return;
  }
  const embedding = report.embedding;
  process.stdout.write([
    `Embedding: ${embedding.state}`,
    ...(embedding.model ? [`Configured model: ${embedding.model}${embedding.digest ? `@${embedding.digest}` : ''}`] : []),
    ...(embedding.index_model ? [`Index model: ${embedding.index_model}@${embedding.index_digest}`] : []),
    ...(embedding.error ? [`Detail: ${embedding.error}`] : []),
    ...(report.index_error ? [`Index: ${report.index_error}`] : []),
    `Coverage: ${report.coverage.embedded}/${report.coverage.total}`,
    `Indexed through: ${report.indexed_through || '(none)'}`,
  ].join('\n') + '\n');
}

function parseNoteShowArgs(argv: string[]): NoteShowOptions {
  const [noteId, ...rest] = argv;
  if (!noteId || noteId.startsWith('--')) {
    throw new Error('note show requires <note_id>');
  }

  const options: NoteShowOptions = { noteId, dataDir: DATA_DIR, withProvenance: false, json: false };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === '--with-provenance') {
      options.withProvenance = true;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--data-dir') {
      const value = rest[i + 1];
      if (value === undefined) {
        throw new Error('flag --data-dir requires a value');
      }
      options.dataDir = value;
      i += 1;
    } else {
      throw new Error(`unexpected argument: ${arg}`);
    }
  }
  return options;
}

function parseRecallArgs(argv: string[]): RecallOptions {
  const [query, ...rest] = argv;
  if (!query || query.startsWith('--')) {
    throw new Error('recall requires <query>');
  }

  const options: RecallOptions = {
    query,
    global: false,
    limit: PULL_RECALL_DEFAULT_LIMIT,
    json: false,
    dataDir: DATA_DIR,
    diagnosticsDir: DIAGNOSTICS_DIR,
    indexDir: INDEX_DIR,
  };

  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === '--global') {
      options.global = true;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--project') {
      const value = rest[i + 1];
      if (value === undefined) {
        throw new Error('flag --project requires a value');
      }
      options.projectSlug = value;
      i += 1;
    } else if (arg === '--origin') {
      const value = rest[i + 1];
      if (value === undefined) {
        throw new Error('flag --origin requires a value');
      }
      options.origin = value;
      i += 1;
    } else if (arg === '--limit') {
      const value = rest[i + 1];
      if (value === undefined) {
        throw new Error('flag --limit requires a value');
      }
      const parsed = Number.parseInt(value, 10);
      if (!Number.isInteger(parsed) || parsed < 0) {
        throw new Error('flag --limit requires a non-negative integer');
      }
      options.limit = Math.min(parsed, PULL_RECALL_LIMIT_CEILING);
      i += 1;
    } else if (arg === '--data-dir') {
      const value = rest[i + 1];
      if (value === undefined) {
        throw new Error('flag --data-dir requires a value');
      }
      options.dataDir = value;
      i += 1;
    } else if (arg === '--diagnostics-dir') {
      const value = rest[i + 1];
      if (value === undefined) {
        throw new Error('flag --diagnostics-dir requires a value');
      }
      options.diagnosticsDir = value;
      i += 1;
    } else if (arg === '--index-dir') {
      const value = rest[i + 1];
      if (value === undefined) throw new Error('flag --index-dir requires a value');
      options.indexDir = value;
      i += 1;
    } else if (arg === '--config') {
      const value = rest[i + 1];
      if (value === undefined) throw new Error('flag --config requires a value');
      options.configPath = value;
      i += 1;
    } else {
      throw new Error(`unexpected argument: ${arg}`);
    }
  }

  return options;
}

function parseWhyArgs(argv: string[]): WhyOptions {
  const [first, ...rest] = argv;
  const options: WhyOptions = { json: false, diagnosticsDir: DIAGNOSTICS_DIR };
  const args = first === undefined || first.startsWith('--') ? argv : rest;
  if (args === rest) {
    options.injectionId = first;
  }
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--json') {
      options.json = true;
    } else if (arg === '--last') {
      options.last = true;
    } else if (arg === '--session') {
      const value = args[i + 1];
      if (value === undefined) {
        throw new Error('flag --session requires a value');
      }
      options.sessionId = value;
      i += 1;
    } else if (arg === '--diagnostics-dir') {
      const value = args[i + 1];
      if (value === undefined) {
        throw new Error('flag --diagnostics-dir requires a value');
      }
      options.diagnosticsDir = value;
      i += 1;
    } else {
      throw new Error(`unexpected argument: ${arg}`);
    }
  }
  if (options.injectionId !== undefined && options.last) {
    throw new Error('why: <injection_id> and --last are mutually exclusive');
  }
  if (options.injectionId === undefined && !options.last) {
    throw new Error('why requires <injection_id> or --last');
  }
  if (options.sessionId !== undefined && !options.last) {
    throw new Error('why: --session requires --last');
  }
  return options;
}

function parseWhySummaryArgs(argv: string[]): WhySummaryOptions {
  const options: WhySummaryOptions = { json: false, diagnosticsDir: DIAGNOSTICS_DIR };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') {
      options.json = true;
    } else if (arg === '--session') {
      const value = argv[i + 1];
      if (value === undefined) {
        throw new Error('flag --session requires a value');
      }
      options.session = value;
      i += 1;
    } else if (arg === '--diagnostics-dir') {
      const value = argv[i + 1];
      if (value === undefined) {
        throw new Error('flag --diagnostics-dir requires a value');
      }
      options.diagnosticsDir = value;
      i += 1;
    } else {
      throw new Error(`unexpected argument: ${arg}`);
    }
  }
  return options;
}

function parseWhyNotArgs(argv: string[]): WhyNotOptions {
  const [query, noteId, ...rest] = argv;
  if (!query || query.startsWith('--')) {
    throw new Error('why-not requires <query>');
  }
  if (!noteId || noteId.startsWith('--')) {
    throw new Error('why-not requires <note_id>');
  }

  const options: WhyNotOptions = { query, noteId, global: false, dataDir: DATA_DIR, indexDir: INDEX_DIR };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === '--global') {
      options.global = true;
    } else if (arg === '--project') {
      const value = rest[i + 1];
      if (value === undefined) {
        throw new Error('flag --project requires a value');
      }
      options.projectSlug = value;
      i += 1;
    } else if (arg === '--data-dir') {
      const value = rest[i + 1];
      if (value === undefined) {
        throw new Error('flag --data-dir requires a value');
      }
      options.dataDir = value;
      i += 1;
    } else if (arg === '--index-dir') {
      const value = rest[i + 1];
      if (value === undefined) throw new Error('flag --index-dir requires a value');
      options.indexDir = value;
      i += 1;
    } else {
      throw new Error(`unexpected argument: ${arg}`);
    }
  }
  if (!options.projectSlug && !options.global) {
    throw new Error('why-not requires --project <slug> or --global');
  }
  return options;
}

export function findLatestNote(dataDir: string, noteId: string): NoteStateRecord | undefined {
  const latest = latestRecordPerNoteId(readAllNotes(dataDir) as NoteRecord[]);
  return latest.find((note) => note.note_id === noteId);
}

function formatScope(scope: NoteRevision['scope']): string {
  const parts = [
    scope.project_slug ? `project_slug=${scope.project_slug}` : undefined,
    scope.git_root ? `git_root=${scope.git_root}` : undefined,
    scope.git_remote ? `git_remote=${scope.git_remote}` : undefined,
    scope.global === true ? 'global=true' : undefined,
  ].filter((part): part is string => part !== undefined);
  return parts.length > 0 ? parts.join(', ') : '(none)';
}

function formatNote(note: NoteRevision): string {
  const lines = [
    `Title: ${note.title}`,
    `Note ID: ${note.note_id}`,
    `Revision ID: ${note.revision_id}`,
    `Type: ${note.note_type}`,
    `Origin: ${note.source.origin}`,
    `Distiller: ${note.source.distiller}`,
    `Created At: ${note.created_at}`,
    `Scope: ${formatScope(note.scope)}`,
    '',
    note.body.summary,
  ];

  if (note.body.bullets && note.body.bullets.length > 0) {
    lines.push('', ...note.body.bullets.map((bullet) => `- ${bullet}`));
  }
  if (note.body.details) {
    lines.push('', note.body.details);
  }
  return lines.join('\n') + '\n';
}

function eventLogPath(dataDir: string, sessionId: string): string {
  return path.join(dataDir, 'events', `${sessionId}.ndjson`);
}

function eventId(event: Record<string, unknown>): string | undefined {
  return typeof event.event_id === 'string' ? event.event_id : undefined;
}

export function provenanceEvents(dataDir: string, note: NoteRevision): Array<Record<string, unknown>> {
  const sessionId = note.provenance.session_id;
  if (!sessionId) {
    throw new Error(`note ${note.note_id} has no provenance.session_id`);
  }

  const logPath = eventLogPath(dataDir, sessionId);
  if (!fs.existsSync(logPath)) {
    throw new Error(`missing provenance session log: expected ${logPath}`);
  }

  const events = readAll(logPath) as Array<Record<string, unknown>>;
  const ids = note.provenance.event_ids;
  if (ids && ids.length > 0) {
    const wanted = new Set(ids);
    const found = events.filter((event) => {
      const id = eventId(event);
      return id !== undefined && wanted.has(id);
    });
    const foundIds = new Set(found.map(eventId).filter((id): id is string => id !== undefined));
    const missing = ids.filter((id) => !foundIds.has(id));
    if (missing.length > 0) {
      throw new Error(`provenance events missing from ${logPath}: ${missing.join(', ')}`);
    }
    return found;
  }

  const range = note.provenance.event_range;
  if (range) {
    const from = range.from_event_id;
    const to = range.to_event_id;
    const found = events.filter((event) => {
      const id = eventId(event);
      return id !== undefined && from <= id && id <= to;
    });
    if (found.length === 0) {
      throw new Error(`provenance event range ${from}..${to} matched no events in ${logPath}`);
    }
    return found;
  }

  throw new Error(`note ${note.note_id} has no event_ids or event_range provenance`);
}

function payloadSummary(event: Record<string, unknown>): string {
  if (event.type === 'prompt') {
    return `prompt: ${(event.prompt as string | undefined) ?? ''}`;
  }
  if (event.type === 'tool') {
    const tool = (event.tool ?? {}) as Record<string, unknown>;
    return `tool: ${(tool.native_name as string | undefined) ?? ''}; files: ${JSON.stringify(event.files ?? [])}`;
  }
  if (event.type === 'session') {
    return `session action: ${(event.action as string | undefined) ?? ''}`;
  }
  return `payload: ${JSON.stringify(event)}`;
}

function formatProvenanceEvents(events: Array<Record<string, unknown>>): string {
  return [
    '',
    'Provenance events:',
    ...events.flatMap((event) => [
      `Event: ${String(event.type ?? '')} ${String(event.ts ?? '')}`,
      `Payload: ${payloadSummary(event)}`,
      `Verbatim: ${JSON.stringify(event)}`,
    ]),
  ].join('\n') + '\n';
}

function formatHumanProvenance(note: NoteRevision): string {
  return [
    '',
    'Human provenance:',
    `Source path: ${note.source.source_path ?? '(none)'}`,
    `Content hash: ${note.source.content_hash ?? '(none)'}`,
    'Human-distilled notes have no event provenance.',
  ].join('\n') + '\n';
}

/**
 * Read stdin canonical-event NDJSON; append each record via `appendEvent` into
 * `<dataDir>/events/{session_id}.ndjson`, routed by the record's own
 * `context.session_id`. Fail loud (§9): a malformed JSON line, a validation
 * failure, or a `record_class: diagnostic` record aborts with a non-zero exit
 * and an error naming the reason; nothing from the failed line is appended.
 */
function collect(flags: Map<string, string>): void {
  const dataDir = flags.get('data-dir') ?? DATA_DIR;
  const input = fs.readFileSync(0, 'utf8');
  const lines = input.split('\n');

  lines.forEach((line, index) => {
    if (line.trim().length === 0) {
      return;
    }

    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`malformed JSON on line ${index + 1}: ${reason}`);
    }

    const context = record.context;
    const sessionId =
      typeof context === 'object' && context !== null
        ? (context as Record<string, unknown>).session_id
        : undefined;
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new Error(`missing context.session_id on line ${index + 1}`);
    }

    const logFilePath = path.join(dataDir, 'events', `${sessionId}.ndjson`);
    try {
      appendEvent(logFilePath, record);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`rejected record on line ${index + 1}: ${reason}`);
    }
  });
}

/**
 * Map the distill flags to an `InferenceProvider` — the single place where
 * provider *selection* lives, kept apart from `distillCommand` so the command
 * reads as intent and the choice is testable without spawning a model.
 *
 * `--provider-fixture <file>` selects an offline provider that returns the
 * file's contents; a JSON array of strings supplies ordered responses (§2:
 * swapping the model is swapping a provider, nothing more). It is a first-class
 * operator switch for offline/canned runs, not a test-only hook — the fixture-
 * backed provider is also how tests avoid a live call. Absent the flag, the real
 * `claude -p` provider is used.
 *
 * `--provider` overrides config selection directly; this remains a branch, not
 * a provider registry.
 */
export function resolveProvider(flags: Map<string, string>, configPath = CONFIG_PATH): InferenceProvider {
  const fixture = flags.get('provider-fixture');
  if (fixture !== undefined) {
    const response = fs.readFileSync(fixture, 'utf8');
    try {
      const scripted = JSON.parse(response);
      if (Array.isArray(scripted) && scripted.every((item) => typeof item === 'string')) {
        return makeScriptedFixtureProvider(scripted, flags.get('model'));
      }
    } catch {
      // A normal fixture is arbitrary provider output, not necessarily JSON.
    }
    return makeFixtureProvider(response, flags.get('model'));
  }
  const config = loadConfig(configPath);
  const provider = flags.get('provider') ?? config.inference.provider;
  if (provider === 'claude') {
    return makeClaudeProvider();
  }
  if (provider !== 'opencode') {
    throw new Error(`unknown provider: ${provider}`);
  }
  const model = flags.get('model') ?? config.inference.model;
  if (!model) {
    throw new Error(`OpenCode provider requires inference.model in ${configPath} or --model <provider/model>`);
  }
  return makeOpencodeProvider({ model });
}

/**
 * Cursor-driven distill trigger (§4 "Owns distill triggering", §8 "Distill
 * verdicts"). Scans `<dataDir>/events/*.ndjson`, applies the skip heuristic,
 * runs the distiller on eligible session deltas, appends notes, writes distill
 * verdicts to the diagnostics dir, and advances cursors after success. The
 * heavy lifting lives in `runDistill`, and provider selection in
 * `resolveProvider`, so this stays a thin shell.
 *
 * Fail loud (§9): a provider/parse failure propagates and aborts with a
 * non-zero exit; the failed session's cursor is not advanced.
 */
async function distillCommand(flags: Map<string, string>): Promise<void> {
  const dataDir = flags.get('data-dir') ?? DATA_DIR;
  const diagnosticsDir = flags.get('diagnostics-dir') ?? DIAGNOSTICS_DIR;
  const provider = resolveProvider(flags, flags.get('config'));

  await runDistill({ dataDir, diagnosticsDir, provider, indexDir: flags.get('index-dir') ?? INDEX_DIR, configPath: flags.get('config') });
}

/**
 * `librarian drain` (spec §4: "the manual recovery and debug tool; more
 * important than any daemon") — one command that processes everything pending
 * across every log consumer and exits. It COMPOSES the existing consumers; it
 * never reimplements locking (#59) or failure handling (#60).
 *
 *   1. Distill everything pending, under the distiller's own lock. A live lock
 *      holder is reported on stderr and does NOT abort the drain — the export
 *      step still runs over whatever notes already exist.
 *   2. Export everything pending to `<vault>/generated/**` — skipped entirely
 *      when `--vault` is absent.
 *   3. Print a one-line-per-fact summary to stdout. "Nothing pending" prints
 *      exactly that and exits 0 — success, not an error.
 *
 * The summary goes to stdout only — never rendered into the vault (§8).
 */
async function drainCommand(flags: Map<string, string>): Promise<void> {
  const dataDir = flags.get('data-dir') ?? DATA_DIR;
  const diagnosticsDir = flags.get('diagnostics-dir') ?? DIAGNOSTICS_DIR;
  const vaultDir = flags.get('vault');
  const indexDir = flags.get('index-dir') ?? INDEX_DIR;
  const provider = resolveProvider(flags, flags.get('config'));

  // runDistill already replayed the note log and embedded (failing loud on a
  // systemic error) — reading coverage here is a signal-only lens, not a second
  // index pass that would re-run the work just to print a count.
  const distilled = await runDistill({ dataDir, diagnosticsDir, provider, indexDir, configPath: flags.get('config') });
  const exported = vaultDir !== undefined ? runExport({ dataDir, vaultDir }) : undefined;
  const index = openIndexWrite(indexDir);
  let coverage: ReturnType<typeof embeddingCoverage>;
  try {
    coverage = embeddingCoverage(index, loadConfig(flags.get('config')).embedding !== undefined);
  } finally {
    index.close();
  }

  const distillWork = distilled.distilled + distilled.duplicates + distilled.skipped + distilled.noops + distilled.quarantined + distilled.rejected;
  const exportWork = (exported?.exported ?? 0) + (exported?.removed ?? 0);
  if (distillWork === 0 && exportWork === 0 && distilled.status === 'pass') {
    // Coverage is live index state, not a work counter — runDistill embedded above
    // regardless of pending sessions, so print it even with nothing to distill or export.
    process.stdout.write(`Nothing pending; index embedding coverage: ${coverage!.embedded}/${coverage!.total} (${coverage!.state})\n`);
    return;
  }

  const lines = [
    `sessions distilled: ${distilled.distilled}`,
    `sessions duplicates: ${distilled.duplicates}`,
    `sessions skipped: ${distilled.skipped}`,
    `sessions noops: ${distilled.noops}`,
    `sessions quarantined: ${distilled.quarantined}`,
    `sessions rejected: ${distilled.rejected}`,
    `index embedding coverage: ${coverage!.embedded}/${coverage!.total} (${coverage!.state})`,
  ];
  if (vaultDir !== undefined) {
    lines.push(`notes exported: ${exported!.exported}`);
    lines.push(`notes removed: ${exported!.removed}`);
  }
  process.stdout.write(lines.join('\n') + '\n');
}

/**
 * Print the persisted machine id, generating and persisting a ULID on first
 * call (§11: a generated persisted id, never the hostname).
 */
function machineId(flags: Map<string, string>): void {
  const machineIdPath = flags.get('path') ?? MACHINE_ID_PATH;
  let id: string;
  if (fs.existsSync(machineIdPath)) {
    id = fs.readFileSync(machineIdPath, 'utf8').trim();
  } else {
    id = ulid();
    fs.mkdirSync(path.dirname(machineIdPath), { recursive: true });
    fs.writeFileSync(machineIdPath, id + '\n');
  }
  process.stdout.write(id + '\n');
}

export function getNoteShowPayload(dataDir: string, noteId: string, withProvenance: boolean): NoteShowPayload {
  const note = findLatestNote(dataDir, noteId);
  if (!note) {
    throw new Error(`unknown note_id: ${noteId}`);
  }

  if (note.kind === 'note_tombstone') {
    return { note, provenance_events: null };
  }

  const events = withProvenance && note.source.distiller !== 'human' ? provenanceEvents(dataDir, note) : [];
  return { note, provenance_events: events };
}

function noteShow(options: NoteShowOptions): void {
  const payload = getNoteShowPayload(options.dataDir, options.noteId, options.withProvenance);
  const note = payload.note;

  if (note.kind === 'note_tombstone') {
    if (options.json) {
      process.stdout.write(JSON.stringify(payload) + '\n');
      return;
    }
    process.stdout.write(
      `Note ${note.note_id} is tombstoned as of ${note.created_at}. Reason: ${note.reason ?? '(none)'}\n`,
    );
    return;
  }

  if (options.json) {
    process.stdout.write(JSON.stringify(payload) + '\n');
    return;
  }

  process.stdout.write(formatNote(note));
  if (!options.withProvenance) {
    return;
  }
  if (note.source.distiller === 'human') {
    process.stdout.write(formatHumanProvenance(note));
    return;
  }
  process.stdout.write(formatProvenanceEvents(provenanceEvents(options.dataDir, note)));
}

function formatRecallResult(result: RecallResult): string {
  const scope = [result.project_slug ? `project=${result.project_slug}` : undefined, result.is_global ? 'global' : undefined]
    .filter((part): part is string => part !== undefined)
    .join(', ');
  const prefix = `${result.note_id} score=${result.score.toFixed(4)} origin=${result.origin} type=${result.note_type}`;
  return `${prefix} scope=${scope || '(none)'} title=${result.title} summary=${result.summary}`;
}

function writePullTrace(options: RecallOptions, candidates: RecallTraceCandidate[], rows: RecallTraceCandidate[], ts: string, indexedThroughWatermark: string, scoring: ScoringConfig, embedding: QueryEmbedding): void {
  const trace: InjectionTrace = {
    record_class: 'diagnostic',
    injection_id: makeInjectionId(),
    path: 'pull',
    ts,
    query: options.query,
    candidates: candidates.map((candidate) => ({
      note_id: candidate.note_id,
      raw_score: candidate.raw_bm25,
      post_weight_score: candidate.score,
      bm25_rank: candidate.bm25_rank,
      knn_rank: candidate.knn_rank,
      cut_reason: candidate.cut_reason,
    })),
    shipped_note_ids: rows.map((row) => row.note_id),
    indexed_through: indexedThroughWatermark,
    embedding: embedding.status,
    ...(embedding.model ? { embedding_digest: embedding.model.digest } : {}),
    config_snapshot: scoringConfigSnapshot(scoring),
  };
  writeInjectionTrace(options.diagnosticsDir, trace);
}

export async function runRecall(options: RecallOptions): Promise<RecallPayload> {
  const ts = new Date().toISOString();
  const scoring = loadConfig(options.configPath).scoring;
  const db = openIndexRead(options.indexDir ?? INDEX_DIR);
  try {
    const embedding = await queryEmbedding(db, options.query, options.configPath);
    const { results: rows, candidates } = recallWithTrace(
      db,
      options.query,
      { projectSlug: options.projectSlug, global: options.global, origin: options.origin, limit: options.limit },
      scoring,
      ts,
      embedding.vector,
    );
    writePullTrace(options, candidates, rows, ts, indexedThrough(db), scoring, embedding);

    const notesById = new Map(stateNotes(db, rows.map((row) => row.note_id)).map((note) => [note.note_id, note]));
    const results: RecallResult[] = rows.flatMap((row) => {
      const note = notesById.get(row.note_id);
      if (!note) {
        return [];
      }
      return [
        {
          note_id: row.note_id,
          title: note.title,
          summary: note.body.summary,
          note_type: row.note_type,
          origin: row.origin,
          created_at: row.created_at,
          project_slug: note.scope.project_slug ?? '',
          is_global: note.scope.global === true,
          score: row.score,
        },
      ];
    });

    const message =
      !options.projectSlug && !options.global
        ? 'No project_slug and global=false; recall is fail-closed without an explicit scope.'
        : undefined;
    return { results, message };
  } finally {
    db.close();
  }
}

async function recallCommand(options: RecallOptions): Promise<void> {
  const payload = await runRecall(options);
  if (options.json) {
    process.stdout.write(JSON.stringify(payload.results) + '\n');
    return;
  }
  process.stdout.write(payload.results.map(formatRecallResult).join('\n') + (payload.results.length > 0 ? '\n' : ''));
}

function formatTrace(trace: InjectionTrace): string {
  const lines = [
    `Injection: ${trace.injection_id}`,
    `Path: ${trace.path ?? '(unknown)'}`,
    `Query: ${trace.query}`,
    `Indexed Through: ${trace.indexed_through}`,
    `Embedding: ${trace.embedding ?? 'disabled'}`,
    ...(trace.embedding_digest ? [`Embedding Digest: ${trace.embedding_digest}`] : []),
    `Config: ${JSON.stringify(trace.config_snapshot)}`,
    'Candidates:',
  ];
  const shipped = new Set(trace.shipped_note_ids);
  for (const candidate of trace.candidates) {
    const status = shipped.has(candidate.note_id) ? 'shipped' : `cut=${candidate.cut_reason ?? '(unknown)'}`;
    const ranks = `bm25=${candidate.bm25_rank ?? '-'} knn=${candidate.knn_rank ?? '-'}`;
    lines.push(
      `- ${candidate.note_id}: raw=${candidate.raw_score.toFixed(4)} -> post=${candidate.post_weight_score.toFixed(4)} [${ranks}] ${status}`,
    );
  }
  return lines.join('\n') + '\n';
}

function whyCommand(options: WhyOptions): void {
  const traces = readInjectionTraces(options.diagnosticsDir);
  let trace: InjectionTrace | undefined;
  if (options.last) {
    // Newest = max-ULID injection_id over push traces (ULIDs are minted at operation
    // time and ms-sortable; ts ordering is unreliable). --session filters first.
    let push = traces.filter((row) => row.path === 'push');
    if (push.length === 0) {
      throw new Error('why --last: no push traces found');
    }
    if (options.sessionId !== undefined) {
      push = push.filter((row) => row.session_id === options.sessionId);
      if (push.length === 0) {
        throw new Error(`why --last: no push traces for session ${options.sessionId}`);
      }
    }
    trace = push.reduce((max, row) => (row.injection_id > max.injection_id ? row : max));
  } else {
    trace = traces.find((row) => row.injection_id === options.injectionId);
    if (trace === undefined) {
      throw new Error(`trace not found — diagnostics may have been deleted: ${options.injectionId}`);
    }
  }
  process.stdout.write(options.json ? JSON.stringify(trace) + '\n' : formatTrace(trace));
}

/**
 * Collect a session's PUSH traces in ULID order for a replay. With no `session`
 * given, self-resolve to the newest session — the `session_id` of the max-ULID
 * push trace (issue #125). Pull/MCP traces are out of scope (no session_id).
 */
export function whySummaryTraces(
  diagnosticsDir: string,
  session?: string,
): { session: string; traces: InjectionTrace[] } {
  const push = readInjectionTraces(diagnosticsDir)
    .filter((t) => t.path === 'push' && t.session_id !== undefined)
    .sort((a, b) => a.injection_id.localeCompare(b.injection_id));
  const resolved = session ?? push[push.length - 1]?.session_id;
  if (resolved === undefined) {
    throw new Error('no push traces with a session_id found');
  }
  return { session: resolved, traces: push.filter((t) => t.session_id === resolved) };
}

function whySummaryCommand(options: WhySummaryOptions): void {
  const { session, traces } = whySummaryTraces(options.diagnosticsDir, options.session);
  if (options.json) {
    process.stdout.write(JSON.stringify({ session, injections: traces.length, traces }) + '\n');
    return;
  }
  const header = `Session ${session} · ${traces.length} injection${traces.length === 1 ? '' : 's'}\n`;
  process.stdout.write(header + traces.map(formatTrace).join('\n'));
}

function formatWhyNot(result: WhyNotResult): string {
  if (!result.matched) {
    return `${result.note_id}: not matched by BM25 at all\n`;
  }
  return [
    `Note: ${result.note_id}`,
    `Rank: ${result.rank}`,
    `Raw Score: ${result.raw_score.toFixed(4)}`,
    `Post-weight Score: ${result.post_weight_score.toFixed(4)}`,
    `Gate: ${result.gate}`,
    ...(result.superseded_by ? [`Superseded By: ${result.superseded_by}`] : []),
  ].join('\n') + '\n';
}

async function whyNotCommand(options: WhyNotOptions): Promise<void> {
  const ts = new Date().toISOString();
  const scoring = loadConfig().scoring;
  const db = openIndexRead(options.indexDir);
  try {
    // Explain against the pull-path result budget the seam actually ships (10), not the
    // scoring RESULT_CAP default (5), so the budget gate matches `librarian recall`.
    const opts = { ...options, limit: PULL_RECALL_DEFAULT_LIMIT };
    // Re-embed with the configured model so hybrid replay explains a KNN-only reach
    // (§6). If embedding is off/unreachable the vector is absent and why-not degrades
    // to BM25-only honestly.
    const embedding = await queryEmbedding(db, options.query);
    process.stdout.write(formatWhyNot(whyNot(db, options.query, options.noteId, opts, scoring, ts, embedding.vector)));
  } finally {
    db.close();
  }
}

async function injectCommand(options: InjectionOptions): Promise<void> {
  options.query = options.sessionStart ? '' : fs.readFileSync(0, 'utf8');
  const block = await buildInjection(options);
  if (block !== undefined) {
    process.stdout.write(block);
  }
}

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;

  switch (command) {
    case 'collect':
      collect(parseFlags(rest));
      break;
    case 'distill':
      await distillCommand(parseFlags(rest));
      break;
    case 'drain':
      await drainCommand(parseFlags(rest));
      break;
    case 'recall':
      await recallCommand(parseRecallArgs(rest));
      break;
    case 'why':
      whyCommand(parseWhyArgs(rest));
      break;
    case 'why-summary':
      whySummaryCommand(parseWhySummaryArgs(rest));
      break;
    case 'why-not':
      await whyNotCommand(parseWhyNotArgs(rest));
      break;
    case 'stats':
      statsCommand(rest);
      break;
    case 'doctor':
      await doctorCommand(rest);
      break;
    case 'supersede':
      await supersede(rest);
      break;
    case 'flag':
      await flagNote(rest);
      break;
    case 'inject':
      await injectCommand(parseInjectArgs(rest));
      break;
    case 'note': {
      const [subcommand, ...subRest] = rest;
      if (subcommand === 'show') {
        noteShow(parseNoteShowArgs(subRest));
      } else if (subcommand === 'import-curated') {
        await noteImportCurated(subRest);
      } else if (subcommand === 'tombstone') {
        await noteTombstone(subRest);
      } else {
        throw new Error('expected note subcommand: show, import-curated, or tombstone');
      }
      break;
    }
    case 'mcp': {
      const flags = parseFlags(rest);
      const { runMcpServer } = await import('./mcp/server.ts');
      await runMcpServer({
        dataDir: flags.get('data-dir') ?? DATA_DIR,
        diagnosticsDir: flags.get('diagnostics-dir') ?? DIAGNOSTICS_DIR,
        indexDir: flags.get('index-dir') ?? INDEX_DIR,
      });
      break;
    }
    case 'machine-id':
      machineId(parseFlags(rest));
      break;
    default:
      process.stderr.write(USAGE);
      process.exit(command === undefined ? 1 : 2);
  }
}

// Auto-run only as the CLI entry point, so this module can be imported (e.g. by
// tests exercising `resolveProvider`) without executing a command.
if (import.meta.main) {
  main(process.argv.slice(2)).catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`librarian: ${message}\n`);
    process.exit(1);
  });
}
