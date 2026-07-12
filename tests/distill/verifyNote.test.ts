import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyNote } from '../../src/distill/verifyNote.ts';
import { makeFixtureProvider } from '../../src/distill/provider.ts';
import type { NoteRevision } from '../../src/note.ts';

const note: NoteRevision = {
  kind: 'note_revision',
  schema_version: 1,
  note_id: 'episode:test',
  revision_id: 'test-revision',
  created_at: '2026-01-01T00:00:00.000Z',
  identity: { mode: 'episodic' },
  source: { origin: 'test', distiller: 'llm' },
  note_type: 'episode',
  title: 'Test note',
  scope: { global: true },
  provenance: {},
  links: [],
  body: { summary: 'Test summary' },
};

const events = [{ type: 'prompt', ts: '2026-01-01T00:00:00.000Z', prompt: 'Test event' }];

test('verifyNote rejects extra fields and contradictory verdicts', async () => {
  for (const response of [
    JSON.stringify({ faithful: true, errors: [], reason: 'ok', extra: true }),
    JSON.stringify({ faithful: true, errors: ['hallucination'], reason: 'contradictory' }),
    JSON.stringify({ faithful: false, errors: [], reason: 'contradictory' }),
  ]) {
    await assert.rejects(verifyNote(note, events, makeFixtureProvider(response)), /invalid verdict shape/);
  }
});
