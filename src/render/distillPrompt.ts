type EventLike = Record<string, unknown>;

/** Extract the `HH:MM` (UTC) portion straight from an ISO 8601 timestamp.
 * String slicing, not `Date`, keeps the rendering deterministic regardless of
 * the host timezone — the prompt boundary elides seconds and the date anyway. */
function hhmm(ts: unknown): string {
  return typeof ts === 'string' ? ts.slice(11, 16) : '';
}

/**
 * Per-event cap on rendered command output, in characters. The log keeps the outcome
 * verbatim; the prompt gets an excerpt (§7 — storage and rendering are separate contracts,
 * and letting the prompt budget dictate the schema is what made failure invisible).
 *
 * Sized to hold a whole ordinary error message — a native-module ABI mismatch runs ~370
 * characters before it names its error code, and an excerpt that stops before the code is
 * an excerpt that lost the lesson.
 */
export const OUTCOME_EXCERPT_CHARS = 400;

/** Collapse whitespace and cut to the cap, so one line stays one line whatever the command
 *  printed. Provably bounded: the result is never longer than the cap plus the ellipsis. */
function excerpt(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > OUTCOME_EXCERPT_CHARS ? `${flat.slice(0, OUTCOME_EXCERPT_CHARS)}…` : flat;
}

/** Render what a command printed: stderr in preference to stdout, because a failure's
 *  explanation is what the distiller is here for. Nothing when there is nothing to say. */
function outcomeSuffix(outcome: unknown): string {
  if (typeof outcome !== 'object' || outcome === null) {
    return '';
  }
  const streams = outcome as Record<string, unknown>;
  const parts: string[] = [];
  if (streams.interrupted === true) {
    parts.push('interrupted');
  }
  const text = [streams.stderr, streams.stdout].find(
    (stream): stream is string => typeof stream === 'string' && stream.length > 0,
  );
  if (text !== undefined) {
    parts.push(excerpt(text));
  }
  return parts.length > 0 ? ` → ${parts.join(' ')}` : '';
}

function toolSummary(event: EventLike): string {
  const command = event.command;
  if (typeof command === 'string' && command.length > 0) {
    return `bash: ${command}${outcomeSuffix(event.outcome)}`;
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
