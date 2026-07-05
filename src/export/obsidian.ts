import fs from 'node:fs';
import path from 'node:path';

/**
 * Obsidian exporter — a note-log *consumer* (§4). Renders a note record into a
 * human-readable Markdown page under the vault's `generated/` tree.
 *
 * Structural invariant (§5, task 008 / structural-invariants.md #3): this writes
 * ONLY under `<vaultDir>/generated/**`, never under `curated/`. `curated/` is
 * human-owned and ingested by the human distiller; mixing the two in one file —
 * or letting the exporter touch `curated/` at all — is forbidden by construction,
 * not by convention. The `librarian_generated: true` frontmatter flag plus the
 * `<!-- librarian:generated; do not edit -->` marker make a generated page
 * self-identifying so curated ingestion can exclude it.
 *
 * Idempotency (§5): the deterministic path is a pure function of `note_id`, so
 * re-exporting the same `note_id` at a new revision OVERWRITES the same file. We
 * do NOT content-diff or check "has this changed" — same id, same path, replace.
 */

/** Colons are legal in ULIDs' `{type}:{ulid}` id scheme but unsafe in filenames
 * on several platforms — map them to `-` so the on-disk name is portable. */
function sanitizeNoteId(noteId: string): string {
  return noteId.replaceAll(':', '-');
}

function frontmatter(note: Record<string, unknown>): string {
  const source = (note.source ?? {}) as Record<string, unknown>;
  const lines = [
    '---',
    'librarian_generated: true',
    `note_id: ${JSON.stringify(note.note_id ?? '')}`,
    `note_type: ${JSON.stringify(note.note_type ?? '')}`,
    `origin: ${JSON.stringify(source.origin ?? '')}`,
    `created_at: ${JSON.stringify(note.created_at ?? '')}`,
    '---',
  ];
  return lines.join('\n');
}

function renderBody(note: Record<string, unknown>): string {
  const body = (note.body ?? {}) as Record<string, unknown>;
  const parts: string[] = [];
  parts.push(`# ${(note.title as string) ?? ''}`);
  parts.push('');
  parts.push((body.summary as string) ?? '');
  if (Array.isArray(body.bullets) && body.bullets.length > 0) {
    parts.push('');
    for (const bullet of body.bullets) {
      parts.push(`- ${String(bullet)}`);
    }
  }
  return parts.join('\n');
}

/**
 * Export a note to the vault's generated tree, returning the written file path.
 *
 * Deterministic path: `<vaultDir>/generated/<note_type>/<sanitized note_id>.md`.
 * Always overwrites (idempotent by `note_id`).
 */
export function exportNoteToVault(vaultDir: string, note: Record<string, unknown>): string {
  const noteType = String(note.note_type ?? 'episode');
  const fileName = `${sanitizeNoteId(String(note.note_id ?? ''))}.md`;
  const filePath = path.join(vaultDir, 'generated', noteType, fileName);

  const content = [
    frontmatter(note),
    '',
    '<!-- librarian:generated; do not edit -->',
    '',
    renderBody(note),
    '',
  ].join('\n');

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  return filePath;
}
