type EventLike = Record<string, unknown>;

/** Extract the `HH:MM` (UTC) portion straight from an ISO 8601 timestamp.
 * String slicing, not `Date`, keeps the rendering deterministic regardless of
 * the host timezone — the prompt boundary elides seconds and the date anyway. */
function hhmm(ts: unknown): string {
  return typeof ts === 'string' ? ts.slice(11, 16) : '';
}

/**
 * Cap on rendered command output, in characters, **per stream**. The log keeps the outcome
 * verbatim; the prompt gets an excerpt (§7 — storage and rendering are separate contracts,
 * and letting the prompt budget dictate the schema is what made failure invisible).
 *
 * Sized to hold a whole ordinary error message — a native-module ABI mismatch runs ~370
 * characters before it names its error code, and an excerpt that stops before the code is
 * an excerpt that lost the lesson.
 *
 * Per stream rather than per event on purpose: splitting one cap between stdout and stderr
 * halves both, which put that same ABI error's code back out of reach the moment the command
 * also printed one line to the other stream. A line is therefore bounded by twice this plus
 * the labels — still bounded, and never at the cost of the thing worth reading.
 */
export const OUTCOME_EXCERPT_CHARS = 400;

/**
 * How much raw text `excerpt` may touch per limit-character excerpt. Collapsing whitespace
 * over a multi-megabyte stdout would copy the whole thing to render one line, so the raw
 * text is sliced first. Whitespace can only shrink a string, so a whitespace-dense head can
 * under-fill the excerpt — cosmetic, and this is the knob.
 *
 * ponytail: 8× headroom; raise it if excerpts start coming back short.
 */
const RAW_HEADROOM = 8;

/** Collapse whitespace and cut to `limit`, so one line stays one line whatever the command
 *  printed. Provably bounded: the result is never longer than `limit` plus the ellipsis. */
export function excerpt(text: string, limit: number): string {
  const flat = text.slice(0, limit * RAW_HEADROOM).replace(/\s+/g, ' ').trim();
  const truncated = flat.length > limit || text.length > limit * RAW_HEADROOM;
  return truncated ? `${flat.slice(0, limit)}…` : flat;
}

function stream(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Render what a command printed. BOTH streams reach the prompt, stdout first: measured over
 * this project's real transcripts, a failing suite prints its failure to STDOUT (`2>&1 |
 * tail`, `node --test`) while stderr carries harness noise — so preferring either stream
 * loses the lesson roughly whenever it matters. stderr is labelled so the model knows which
 * stream it is reading.
 */
function outcomeSuffix(outcome: unknown): string {
  if (typeof outcome !== 'object' || outcome === null) {
    return '';
  }
  const streams = outcome as Record<string, unknown>;
  const out = stream(streams.stdout);
  const err = stream(streams.stderr);

  const parts: string[] = [];
  if (streams.interrupted === true) {
    parts.push('interrupted');
  }
  // A non-zero exit is the harness's own verdict and the cheapest signal on the line. A zero
  // exit is left implicit — "it worked" is the default reading of a command with no verdict,
  // and spending prompt tokens restating it on every successful command is not worth it.
  if (typeof streams.exit === 'number' && streams.exit !== 0) {
    parts.push(`exit ${streams.exit}`);
  }
  if (out !== undefined) {
    parts.push(excerpt(out, OUTCOME_EXCERPT_CHARS));
  }
  if (err !== undefined) {
    parts.push(`stderr: ${excerpt(err, OUTCOME_EXCERPT_CHARS)}`);
  }
  return parts.length > 0 ? ` → ${parts.join(' | ')}` : '';
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
