export class DiagnosticRecordRejectedError extends Error {
  constructor() {
    super('diagnostic records are hard-rejected at the collector boundary');
    this.name = 'DiagnosticRecordRejectedError';
  }
}

const EVENT_TYPES = ['prompt', 'tool', 'session'];

/** Boundary strengths an adapter may claim (issue #169). Validated because `collect` reads
 *  NDJSON from anyone's stdin, and the trigger downstream switches on this field — garbage
 *  here would land in an append-only log that is never deleted. */
const BOUNDARY_KINDS = ['terminal', 'semantic', 'compaction'];

/** And which signals. Enum-checked like `kind`: a typo'd signal (`session_ended`) would land in
 *  a log that is never deleted and no trigger would ever match it. */
const BOUNDARY_SIGNALS = ['session_end', 'compact', 'git_commit', 'todos_complete'];

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`${label} is required and must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireString(record: Record<string, unknown>, field: string, label: string): void {
  if (typeof record[field] !== 'string') {
    throw new Error(`${label} is required and must be a string`);
  }
}

export function validateEvent(record: unknown): void {
  const r = asRecord(record, 'event');

  if ('record_class' in r) {
    throw new DiagnosticRecordRejectedError();
  }
  if (r.schema_version !== 1) {
    throw new Error('schema_version must be 1');
  }
  if (typeof r.type !== 'string' || !EVENT_TYPES.includes(r.type)) {
    throw new Error(`type must be one of ${EVENT_TYPES.join(', ')}`);
  }
  requireString(r, 'event_id', 'event_id');
  requireString(r, 'ts', 'ts');

  const resource = asRecord(r.resource, 'resource');
  requireString(resource, 'agent', 'resource.agent');
  requireString(resource, 'machine_id', 'resource.machine_id');
  requireString(resource, 'cwd', 'resource.cwd');

  const context = asRecord(r.context, 'context');
  requireString(context, 'session_id', 'context.session_id');
  requireString(context, 'cwd', 'context.cwd');

  if (r.boundary !== undefined) {
    const boundary = asRecord(r.boundary, 'boundary');
    if (typeof boundary.kind !== 'string' || !BOUNDARY_KINDS.includes(boundary.kind)) {
      throw new Error(`boundary.kind must be one of ${BOUNDARY_KINDS.join(', ')}`);
    }
    if (typeof boundary.signal !== 'string' || !BOUNDARY_SIGNALS.includes(boundary.signal)) {
      throw new Error(`boundary.signal must be one of ${BOUNDARY_SIGNALS.join(', ')}`);
    }
  }

  if (r.type === 'prompt') {
    requireString(r, 'prompt', 'prompt (PromptEvent)');
  } else if (r.type === 'tool') {
    const tool = asRecord(r.tool, 'tool (ToolEvent)');
    requireString(tool, 'native_name', 'tool.native_name');
    requireString(tool, 'canonical_name', 'tool.canonical_name');
    requireString(tool, 'category', 'tool.category');
  } else if (r.type === 'session') {
    requireString(r, 'action', 'action (SessionEvent)');
  }
}
