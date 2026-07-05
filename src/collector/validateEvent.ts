export class DiagnosticRecordRejectedError extends Error {
  constructor() {
    super('diagnostic records are hard-rejected at the collector boundary');
    this.name = 'DiagnosticRecordRejectedError';
  }
}

const EVENT_TYPES = ['prompt', 'tool', 'session'];

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
