import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { getNoteShowPayload, runRecall, type RecallOptions } from '../cli.ts';
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

export function createMcpServer(options: McpServerOptions): Server {
  const server = new Server(
    { name: 'librarian', version: '0.0.0' },
    {
      capabilities: { tools: {} },
      instructions: AUTHORITY_FRAMING,
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [SEARCH_TOOL, GET_NOTES_TOOL, GET_NOTE_TOOL] }));

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
