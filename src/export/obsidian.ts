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
 * Idempotency (§5): the ULID tail identifies episodic notes. Re-exporting the
 * same `note_id` removes any matching old filename before writing the current
 * title, so no content-diff is needed.
 */

/** Colons are legal in ULIDs' `{type}:{ulid}` id scheme but unsafe in filenames
 * on several platforms — map them to `-` so the on-disk name is portable. */
function sanitizeNoteId(noteId: string): string {
  return noteId.replaceAll(':', '-');
}

function shortUlid(noteId: string): string | undefined {
  const candidate = noteId.split(':').at(-1) ?? '';
  return /^[0-9A-HJKMNP-TV-Z]{26}$/.test(candidate) ? candidate.slice(-8) : undefined;
}

function slugifyTitle(title: string): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return slug || 'untitled';
}

function fileNameFor(note: Record<string, unknown>): string {
  const noteId = String(note.note_id ?? '');
  const suffix = shortUlid(noteId);
  return suffix
    ? `${slugifyTitle(String(note.title ?? ''))}--${suffix}.md`
    : `${sanitizeNoteId(noteId)}.md`;
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
 * Episodic ULID paths are `<vaultDir>/generated/<note_type>/<title>--<ULID tail>.md`.
 * Other note IDs retain their sanitized deterministic paths. Always overwrites
 * (idempotent by `note_id`).
 */
export function exportNoteToVault(vaultDir: string, note: Record<string, unknown>): string {
  const noteType = String(note.note_type ?? 'episode');
  const fileName = fileNameFor(note);
  const outputDir = path.join(vaultDir, 'generated', noteType);
  const filePath = path.join(outputDir, fileName);
  const suffix = shortUlid(String(note.note_id ?? ''));

  fs.mkdirSync(outputDir, { recursive: true });
  if (suffix) {
    const legacyFileName = `${sanitizeNoteId(String(note.note_id ?? ''))}.md`;
    for (const existing of fs.readdirSync(outputDir)) {
      if (existing !== fileName && (existing === legacyFileName || existing.endsWith(`--${suffix}.md`))) {
        fs.unlinkSync(path.join(outputDir, existing));
      }
    }
  }

  const content = [
    frontmatter(note),
    '',
    '<!-- librarian:generated; do not edit -->',
    '',
    renderBody(note),
    '',
  ].join('\n');

  fs.writeFileSync(filePath, content);
  return filePath;
}
