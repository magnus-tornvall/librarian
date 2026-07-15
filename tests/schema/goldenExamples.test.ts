import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const EVENT_DIR = path.join(import.meta.dirname, '..', '..', 'schema', 'examples', 'event');
const NOTE_DIR = path.join(import.meta.dirname, '..', '..', 'schema', 'examples', 'note');

function loadJsonFiles(dir: string): Array<{ file: string; data: unknown }> {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => ({
      file: name,
      data: JSON.parse(readFileSync(path.join(dir, name), 'utf8')),
    }));
}

for (const { file, data } of loadJsonFiles(EVENT_DIR)) {
  test(`event golden example: ${file}`, () => {
    const event = data as Record<string, unknown>;
    assert.equal(event.schema_version, 1);
    assert.equal(typeof event.event_id, 'string');
    assert.ok((event.event_id as string).length > 0);
    assert.equal(typeof event.ts, 'string');
    assert.ok(typeof event.resource === 'object' && event.resource !== null);
    assert.ok(typeof event.context === 'object' && event.context !== null);
    assert.ok(['prompt', 'tool', 'session'].includes(event.type as string));
  });
}

for (const { file, data } of loadJsonFiles(NOTE_DIR)) {
  test(`note golden example: ${file}`, () => {
    const note = data as Record<string, unknown>;
    assert.equal(note.schema_version, 1);
    assert.ok(['note_revision', 'note_tombstone', 'note_supersession'].includes(note.kind as string));

    if (note.kind === 'note_revision') {
      const source = note.source as Record<string, unknown>;
      assert.equal(typeof source.origin, 'string');
      assert.ok((source.origin as string).length > 0);
      assert.ok(['llm', 'human'].includes(source.distiller as string));
    }
  });
}
