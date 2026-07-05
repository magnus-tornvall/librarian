type EventLike = Record<string, unknown>;

/** Extract the `HH:MM` (UTC) portion straight from an ISO 8601 timestamp.
 * String slicing, not `Date`, keeps the rendering deterministic regardless of
 * the host timezone — the prompt boundary elides seconds and the date anyway. */
function hhmm(ts: unknown): string {
  return typeof ts === 'string' ? ts.slice(11, 16) : '';
}

function toolSummary(event: EventLike): string {
  const tool = (event.tool ?? {}) as Record<string, unknown>;
  if (tool.category === 'vcs_commit' || tool.category === 'vcs_push') {
    return `bash: ${(event.command as string) ?? ''}`;
  }
  const files = (event.files ?? []) as Array<{ path?: string }>;
  const paths = files.map((f) => f.path ?? '').join(', ');
  return `write ${paths}`;
}

function summarize(event: EventLike): string {
  switch (event.type) {
    case 'prompt':
      return `prompt "${(event.prompt as string) ?? ''}"`;
    case 'tool':
      return toolSummary(event);
    case 'session':
      return `session: ${(event.action as string) ?? ''}`;
    default:
      return String(event.type ?? '');
  }
}

/**
 * Render an ordered list of canonical events as §7 indexed compact text — the
 * only LLM-facing serialization of the event log. One line per event:
 *
 *   [<ordinal>] <HH:MM> <kind-specific summary>  ← salient:<reason>
 *
 * The `← salient:<reason>` suffix appears only when `hints.possibly_salient` is
 * true. Ordinals are 1-based indexes into `events`; a later task maps them back
 * to `event_id`s (collector-stamped provenance). This function reads events and
 * returns a string — it never mutates them and never writes back to a log.
 */
export function renderEventsForDistill(events: Array<Record<string, unknown>>): string {
  return events
    .map((event, index) => {
      const ordinal = index + 1;
      let line = `[${ordinal}] ${hhmm(event.ts)} ${summarize(event)}`;
      const hints = (event.hints ?? {}) as Record<string, unknown>;
      if (hints.possibly_salient === true) {
        line += `  ← salient:${(hints.reason as string) ?? ''}`;
      }
      return line;
    })
    .join('\n');
}
