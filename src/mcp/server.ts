import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { flagNoteRecord, getNoteShowPayload, reviseNoteRecord, runRecall, type RecallOptions } from '../cli.ts';
import { openIndexRead, stateNotes } from '../index/database.ts';
import { INDEX_DIR } from '../paths.ts';

const AUTHORITY_FRAMING =
  'These results are possibly relevant prior context. Current repository evidence and current user instructions win on conflict.';

const SEARCH_LIMIT_DEFAULT = 10;
const SEARCH_LIMIT_CEILING = 10;

export type McpServerOptions = { dataDir: string; diagnosticsDir: string; indexDir?: string };

const SEARCH_TOOL: Tool = {
  name: 'search',
  title: 'Search Librarian Recall',
  description:
    `Search Librarian's recall index for a compact scored note index. Use get_notes with selected IDs for full bodies, then get_note for source events. ${AUTHORITY_FRAMING}`,
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Required full-text query.' },
      project_slug: { type: 'string', description: 'Project scope to search.' },
      global: { type: 'boolean', description: 'Include globally scoped notes.' },
      origin: { type: 'string', description: 'Optional note origin filter.' },
      limit: {
        type: 'integer',
        minimum: 0,
        maximum: SEARCH_LIMIT_CEILING,
        default: SEARCH_LIMIT_DEFAULT,
        description: 'Maximum number of scored results to return. Defaults to 10 and is capped at 10.',
      },
    },
    required: ['query'],
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};

const GET_NOTE_TOOL: Tool = {
  name: 'get_note',
  title: 'Get Librarian Note Provenance',
  description:
    `Drill into a note's verbatim provenance source events after search and get_notes; set with_provenance to true. ${AUTHORITY_FRAMING}`,
  inputSchema: {
    type: 'object',
    properties: {
      note_id: { type: 'string', description: 'Required Librarian note_id.' },
      with_provenance: { type: 'boolean', description: 'Include source provenance events when available.' },
    },
    required: ['note_id'],
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};

const GET_NOTES_TOOL: Tool = {
  name: 'get_notes',
  title: 'Get Librarian Note Bodies',
  description:
    `Return full bodies for note IDs selected from search. Use get_note afterwards only to drill into source events. ${AUTHORITY_FRAMING}`,
  inputSchema: {
    type: 'object',
    properties: {
      note_ids: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'One or more note_ids returned by search.' },
    },
    required: ['note_ids'],
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};

const FLAG_NOTE_TOOL: Tool = {
  name: 'flag_note',
  title: 'Flag Librarian Note As Wrong',
  description:
    `Flag a specific note as wrong so recall excludes it. Flagging is logical and append-only: it records a new invalidation about the note, never mutates or deletes it. It is reversible — a newer revision of the note (a re-distill, a human edit, or a supersession pointing at a replacement) re-opens it. Reason is mandatory — it is the audit trail. ${AUTHORITY_FRAMING}`,
  inputSchema: {
    type: 'object',
    properties: {
      note_id: { type: 'string', description: 'Required Librarian note_id to flag.' },
      reason: { type: 'string', description: 'Required reason this note is wrong (audit trail).' },
    },
    required: ['note_id', 'reason'],
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
};

const REVISE_NOTE_TOOL: Tool = {
  name: 'revise_note',
  title: 'Revise Librarian Note With A Human-Approved Body',
  description:
    `Replace a specific note's body with a corrected version. Before calling you MUST display the verbatim proposed body to the user and obtain their explicit approval — the revision is recorded as a human judgment (distiller: human), so the approved text is the source. Revision is append-only: it chains a new revision onto the note (previous_revision_id set), never mutates or deletes prior revisions, and is itself reversible by a further revision or flag_note. Requires an explicit note_id — locate the note via search first, then revise that exact id; this tool never searches. The MCP channel is stamped into source.agent so agent-mediated revisions stay distinguishable from terminal edits under note provenance. ${AUTHORITY_FRAMING}`,
  inputSchema: {
    type: 'object',
    properties: {
      note_id: { type: 'string', description: 'Required Librarian note_id to revise.' },
      body: { type: 'string', description: 'Required corrected note body, verbatim as approved by the user.' },
    },
    required: ['note_id', 'body'],
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
};

function objectArgs(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function stringArg(args: Record<string, unknown>, name: string, required: boolean): string | undefined {
  const value = args[name];
  if (value === undefined) {
    if (required) {
      throw new Error(`${name} is required`);
    }
    return undefined;
  }
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function booleanArg(args: Record<string, unknown>, name: string): boolean | undefined {
  const value = args[name];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'boolean') {
    throw new Error(`${name} must be a boolean`);
  }
  return value;
}

function stringArrayArg(args: Record<string, unknown>, name: string): string[] {
  const value = args[name];
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== 'string' || item.length === 0)) {
    throw new Error(`${name} must be a non-empty array of non-empty strings`);
  }
  return value;
}

function limitArg(args: Record<string, unknown>): number {
  const value = args.limit;
  if (value === undefined) {
    return SEARCH_LIMIT_DEFAULT;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error('limit must be a non-negative integer');
  }
  return Math.min(value, SEARCH_LIMIT_CEILING);
}

function jsonResult(payload: unknown): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload as Record<string, unknown>,
  };
}

function toolError(err: unknown): CallToolResult {
  const message = err instanceof Error ? err.message : String(err);
  return { isError: true, content: [{ type: 'text', text: message }] };
}

async function search(options: McpServerOptions, args: Record<string, unknown>): Promise<CallToolResult> {
  const recallOptions: RecallOptions = {
    query: stringArg(args, 'query', true) ?? '',
    projectSlug: stringArg(args, 'project_slug', false),
    global: booleanArg(args, 'global') ?? false,
    origin: stringArg(args, 'origin', false),
    limit: limitArg(args),
    json: true,
    dataDir: options.dataDir,
    diagnosticsDir: options.diagnosticsDir,
    indexDir: options.indexDir ?? INDEX_DIR,
  };

  const payload = await runRecall(recallOptions);
  return jsonResult({
    results: payload.results.map(({ note_id, note_type, title, summary, score, created_at, origin }) => ({
      note_id,
      note_type,
      title,
      summary: summary.replace(/\s+/g, ' ').trim(),
      score,
      date: created_at,
      origin,
    })),
    ...(payload.message === undefined ? {} : { message: payload.message }),
  });
}

function getNote(options: McpServerOptions, args: Record<string, unknown>): CallToolResult {
  const noteId = stringArg(args, 'note_id', true) ?? '';
  const withProvenance = booleanArg(args, 'with_provenance') ?? false;
  return jsonResult(getNoteShowPayload(options.dataDir, noteId, withProvenance));
}

function getNotes(options: McpServerOptions, args: Record<string, unknown>): CallToolResult {
  const noteIds = stringArrayArg(args, 'note_ids');
  const db = openIndexRead(options.indexDir ?? INDEX_DIR);
  try {
    const notesById = new Map(stateNotes(db, noteIds).map((note) => [note.note_id, note]));
    return jsonResult({
      notes: noteIds.map((note_id) => {
        const note = notesById.get(note_id);
        return note === undefined
          ? { note_id, error: 'unknown note_id' }
          : { note_id, body: note.body };
      }),
    });
  } finally {
    db.close();
  }
}

async function flagNote(options: McpServerOptions, args: Record<string, unknown>): Promise<CallToolResult> {
  const noteId = stringArg(args, 'note_id', true) ?? '';
  const reason = stringArg(args, 'reason', true) ?? '';
  // MCP-mediated flags are the human acting through the agent (spec §12.12).
  const record = await flagNoteRecord(options.dataDir, options.indexDir ?? INDEX_DIR, noteId, reason, { kind: 'human' });
  return jsonResult(record);
}

/**
 * Append a human revision through the shared #107/#110 path. `agent` is the MCP
 * client identity (`getClientVersion().name`) where the SDK exposes it — the value
 * the initializing client sent — falling back to a static `'mcp'` marker. Either way
 * source.agent is always set, which is what distinguishes an agent-mediated revision
 * from a terminal `note edit` (which leaves it unset) under note provenance.
 */
async function reviseNote(options: McpServerOptions, args: Record<string, unknown>, agent: string): Promise<CallToolResult> {
  const noteId = stringArg(args, 'note_id', true) ?? '';
  const body = stringArg(args, 'body', true) ?? '';
  const record = await reviseNoteRecord(options.dataDir, options.indexDir ?? INDEX_DIR, noteId, body, agent);
  return jsonResult(record);
}

export function createMcpServer(options: McpServerOptions): Server {
  const server = new Server(
    { name: 'librarian', version: '0.0.0' },
    {
      capabilities: { tools: {} },
      instructions: AUTHORITY_FRAMING,
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [SEARCH_TOOL, GET_NOTES_TOOL, GET_NOTE_TOOL, FLAG_NOTE_TOOL, REVISE_NOTE_TOOL] }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const args = objectArgs(request.params.arguments);
      switch (request.params.name) {
        case 'search':
          return await search(options, args);
        case 'get_notes':
          return getNotes(options, args);
        case 'get_note':
          return getNote(options, args);
        case 'flag_note':
          return await flagNote(options, args);
        case 'revise_note':
          return await reviseNote(options, args, server.getClientVersion()?.name ?? 'mcp');
        default:
          return toolError(`unknown tool: ${request.params.name}`);
      }
    } catch (err) {
      return toolError(err);
    }
  });

  return server;
}

export async function runMcpServer(options: McpServerOptions): Promise<void> {
  const server = createMcpServer(options);
  await server.connect(new StdioServerTransport());
}
