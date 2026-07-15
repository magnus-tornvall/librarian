import fs from 'node:fs';
import path from 'node:path';
import { readAllNotes } from '../log/noteLog.ts';
import { readCursor, advanceCursor } from '../log/cursor.ts';
import { latestRecordPerNoteId, type NoteRecord, type NoteRevision } from '../note.ts';
import { exportNoteToVault } from './obsidian.ts';

/**
 * Obsidian export as a cursor-tracked note-log consumer (§4, issue #62). Reads
 * note records past the `"exporter"` cursor, applies latest-revision-wins and
 * tombstones exactly the way the indexer does (`src/index/indexer.ts`): a
 * tombstoned note's generated file is removed, a surviving revision is
 * (re)written by `exportNoteToVault`. Advances the cursor only after the whole
 * pass succeeds — advance-after-success (§5).
 *
 * The cursor's `byte_offset` counts note *records* consumed from the ordered
 * note log, not bytes: the note log is segmented year-month files, so there is
 * no single byte stream to offset into. `readAllNotes` reads segments in sorted
 * order deterministically, so the record count is a stable resumable cursor. A
 * second drain over an unchanged log reads zero new records and writes nothing —
 * the provable no-op the DoD requires.
 *
 * ponytail: record-count cursor + O(n) rescan of the full note log per run —
 * mirrors the indexer's decision at this scale; a true byte-offset stream is the
 * upgrade path once the log grows large enough to matter.
 *
 * ponytail: the record-count cursor is stable only because every writer stamps
 * `created_at = now` (llmDistiller / humanDistiller), so append order == the
 * sorted-segment order this counts against. A writer that ever backdates a
 * record across a month boundary could land it before the cursor and be skipped;
 * a per-segment (offset-per-file) cursor is the fix if that ever becomes real.
 */

const CONSUMER = 'exporter';

export type ExportRunOptions = { dataDir: string; vaultDir: string };
export type ExportRunResult = { exported: number; removed: number };

function cursorPathFor(dataDir: string): string {
  return path.join(dataDir, 'cursors', CONSUMER, 'notes.json');
}

function sanitizeNoteId(noteId: string): string {
  return noteId.replaceAll(':', '-');
}

function shortUlid(noteId: string): string | undefined {
  const candidate = noteId.split(':').at(-1) ?? '';
  return /^[0-9A-HJKMNP-TV-Z]{26}$/.test(candidate) ? candidate.slice(-8) : undefined;
}

/** Remove any generated file for `noteId`, searching every `generated/<type>/`
 * dir — a tombstone carries no note_type, so the file's type dir is unknown. */
function removeGenerated(vaultDir: string, noteId: string): boolean {
  const generatedDir = path.join(vaultDir, 'generated');
  if (!fs.existsSync(generatedDir)) {
    return false;
  }
  const legacyFileName = `${sanitizeNoteId(noteId)}.md`;
  const suffix = shortUlid(noteId);
  let removed = false;
  for (const typeDir of fs.readdirSync(generatedDir)) {
    const typePath = path.join(generatedDir, typeDir);
    if (!fs.statSync(typePath).isDirectory()) continue;
    for (const fileName of fs.readdirSync(typePath)) {
      if (fileName !== legacyFileName && (!suffix || !fileName.endsWith(`--${suffix}.md`))) continue;
      fs.unlinkSync(path.join(typePath, fileName));
      removed = true;
    }
  }
  return removed;
}

/**
 * Run one export pass. Only records past the cursor are considered, then
 * latest-revision-wins collapses them: a note whose latest record (across the
 * WHOLE log, not just the delta — a tombstone in the delta must retire an
 * earlier-exported revision) is a tombstone has its generated file removed; a
 * surviving revision is written. The cursor advances to the full record count.
 */
export function runExport(options: ExportRunOptions): ExportRunResult {
  const { dataDir, vaultDir } = options;
  const allRecords = readAllNotes(dataDir) as NoteRecord[];
  const cursorPath = cursorPathFor(dataDir);
  const start = readCursor(cursorPath)?.byte_offset ?? 0;

  // Nothing new since the last pass — the idempotent no-op path.
  if (start >= allRecords.length) {
    return { exported: 0, removed: 0 };
  }

  // Which note_ids changed in this delta. Only those get re-materialized, but
  // their winning record is resolved against the FULL history so a delta
  // tombstone correctly retires a revision exported in an earlier pass.
  const touched = new Set(allRecords.slice(start).filter((record) => record.kind !== 'note_supersession').map((r) => r.note_id));
  const latestById = new Map(
    latestRecordPerNoteId(allRecords).map((record) => [record.note_id, record]),
  );

  let exported = 0;
  let removed = 0;
  for (const noteId of touched) {
    const latest = latestById.get(noteId);
    if (!latest || latest.kind === 'note_tombstone') {
      if (removeGenerated(vaultDir, noteId)) removed += 1;
      continue;
    }
    // Remove any stale file first: the export path bakes note_type into the
    // directory, so if a revision ever changed note_type the old file would
    // linger beside the new one, breaking idempotency-by-note_id. No writer does
    // this today (episodic note_type is fixed in the note_id), so it's cheap
    // insurance, not a live bug — and it costs nothing when there's no stale file.
    removeGenerated(vaultDir, noteId);
    exportNoteToVault(vaultDir, latest as NoteRevision as unknown as Record<string, unknown>);
    exported += 1;
  }

  advanceCursor(cursorPath, {
    consumer: CONSUMER,
    log_name: 'notes',
    file_path: path.join(dataDir, 'notes'),
    byte_offset: allRecords.length,
    updated_at: new Date().toISOString(),
  });

  return { exported, removed };
}
