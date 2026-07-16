import type { DistillVerdict } from './distillVerdict.ts';
import type { InjectionTrace } from './injectionTrace.ts';

export const DEAD_NOTE_WINDOW_DAYS = 30;
export const PERPETUAL_CANDIDATE_MIN_APPEARANCES = 3;

const DECISIONS: DistillVerdict['decision'][] = [
  'distilled', 'duplicate', 'skipped', 'noop', 'quarantined', 'rejected', 'contradiction',
];
const CUT_REASONS = ['below_floor', 'budget', 'scope_mismatch', 'superseded', 'ttl_expired', 'unknown'] as const;

type CountRate = { count: number; rate: number };
type Breakdown = { total: number; decisions: Record<DistillVerdict['decision'], CountRate> };
export type StatsNote = { note_id: string; title: string; created_at: string };
type ReportNote = Pick<StatsNote, 'note_id' | 'title'>;

export type StatsReport = {
  admission: {
    total: number;
    by_month: Record<string, Breakdown>;
    by_origin: Record<string, Breakdown>;
    by_provider: Record<string, Breakdown>;
  };
  usage: {
    trace_count: number;
    injections_per_note: Record<string, number>;
    dead_window_days: number;
    dead_notes: ReportNote[];
    dead_note_ratio: number;
    perpetual_candidate_min_appearances: number;
    perpetual_candidates: Array<ReportNote & { appearances: number }>;
  };
  cut_reasons: { total: number; mix: Record<(typeof CUT_REASONS)[number], CountRate> };
};

function breakdown(verdicts: DistillVerdict[]): Breakdown {
  const total = verdicts.length;
  return {
    total,
    decisions: Object.fromEntries(DECISIONS.map((decision) => {
      const count = verdicts.filter((verdict) => verdict.decision === decision).length;
      return [decision, { count, rate: total === 0 ? 0 : count / total }];
    })) as Breakdown['decisions'],
  };
}

function grouped(verdicts: DistillVerdict[], key: (verdict: DistillVerdict) => string): Record<string, Breakdown> {
  const groups = new Map<string, DistillVerdict[]>();
  for (const verdict of verdicts) {
    const value = key(verdict);
    groups.set(value, [...(groups.get(value) ?? []), verdict]);
  }
  return Object.fromEntries([...groups].sort(([a], [b]) => a.localeCompare(b)).map(([name, rows]) => [name, breakdown(rows)]));
}

export function computeStats({
  verdicts,
  traces,
  notes,
  now,
}: {
  verdicts: DistillVerdict[];
  traces: InjectionTrace[];
  notes: StatsNote[];
  now: Date;
}): StatsReport {
  const shipped = new Map<string, number>();
  const recentShipped = new Set<string>();
  const candidateStats = new Map<string, { appearances: number; onlyBelowFloor: boolean }>();
  const cutCounts = Object.fromEntries(CUT_REASONS.map((reason) => [reason, 0])) as Record<(typeof CUT_REASONS)[number], number>;
  const cutoff = now.getTime() - DEAD_NOTE_WINDOW_DAYS * 24 * 60 * 60 * 1000;

  for (const trace of traces) {
    const isRecent = new Date(trace.ts).getTime() >= cutoff;
    for (const noteId of trace.shipped_note_ids) {
      shipped.set(noteId, (shipped.get(noteId) ?? 0) + 1);
      if (isRecent) recentShipped.add(noteId);
    }
    for (const candidate of trace.candidates) {
      if (!trace.shipped_note_ids.includes(candidate.note_id)) {
        const reason = candidate.cut_reason ?? 'unknown';
        cutCounts[reason] += 1;
        const current = candidateStats.get(candidate.note_id) ?? { appearances: 0, onlyBelowFloor: true };
        current.appearances += 1;
        current.onlyBelowFloor &&= candidate.cut_reason === 'below_floor';
        candidateStats.set(candidate.note_id, current);
      }
    }
  }

  const noteById = new Map(notes.map((note) => [note.note_id, note]));
  const eligibleNotes = notes.filter((note) => new Date(note.created_at).getTime() <= cutoff);
  const hasRecentTraces = traces.some((trace) => new Date(trace.ts).getTime() >= cutoff);
  const deadNotes = !hasRecentTraces
    ? []
    : eligibleNotes
      .filter((note) => !recentShipped.has(note.note_id))
      .map(({ note_id, title }) => ({ note_id, title }))
      .sort((a, b) => a.note_id.localeCompare(b.note_id));
  const perpetualCandidates = [...candidateStats]
    .filter(([noteId, stats]) => !shipped.has(noteId) && stats.onlyBelowFloor && stats.appearances >= PERPETUAL_CANDIDATE_MIN_APPEARANCES)
    .map(([noteId, stats]) => ({ note_id: noteId, title: noteById.get(noteId)?.title ?? '(unknown)', appearances: stats.appearances }))
    .sort((a, b) => a.note_id.localeCompare(b.note_id));
  const cutTotal = Object.values(cutCounts).reduce((sum, count) => sum + count, 0);

  return {
    admission: {
      total: verdicts.length,
      by_month: grouped(verdicts, (verdict) => verdict.ts.slice(0, 7)),
      by_origin: grouped(verdicts, (verdict) => verdict.origin ?? 'unknown'),
      by_provider: grouped(verdicts, (verdict) => verdict.provider ?? 'unknown'),
    },
    usage: {
      trace_count: traces.length,
      injections_per_note: Object.fromEntries([...shipped].sort(([a], [b]) => a.localeCompare(b))),
      dead_window_days: DEAD_NOTE_WINDOW_DAYS,
      dead_notes: deadNotes,
      dead_note_ratio: eligibleNotes.length === 0 || !hasRecentTraces ? 0 : deadNotes.length / eligibleNotes.length,
      perpetual_candidate_min_appearances: PERPETUAL_CANDIDATE_MIN_APPEARANCES,
      perpetual_candidates: perpetualCandidates,
    },
    cut_reasons: {
      total: cutTotal,
      mix: Object.fromEntries(CUT_REASONS.map((reason) => [reason, { count: cutCounts[reason], rate: cutTotal === 0 ? 0 : cutCounts[reason] / cutTotal }])) as StatsReport['cut_reasons']['mix'],
    },
  };
}

function percent(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

function formatBreakdowns(groups: Record<string, Breakdown>): string[] {
  if (Object.keys(groups).length === 0) return ['(none)'];
  return Object.entries(groups).map(([name, group]) =>
    `${name}: ${DECISIONS.map((decision) => `${decision} ${group.decisions[decision].count} (${percent(group.decisions[decision].rate)})`).join(', ')}`,
  );
}

export function formatStats(report: StatsReport): string {
  const injections = Object.entries(report.usage.injections_per_note);
  const cuts = Object.entries(report.cut_reasons.mix);
  return [
    'Admission funnel',
    `Total verdicts: ${report.admission.total}`,
    'By month:', ...formatBreakdowns(report.admission.by_month),
    'By origin:', ...formatBreakdowns(report.admission.by_origin),
    'By provider:', ...formatBreakdowns(report.admission.by_provider),
    '',
    'Usage',
    `Injection traces: ${report.usage.trace_count}`,
    `Injections per note: ${injections.length === 0 ? '(none)' : injections.map(([id, count]) => `${id}=${count}`).join(', ')}`,
    `Dead notes (${report.usage.dead_window_days}d): ${report.usage.dead_notes.length} (${percent(report.usage.dead_note_ratio)})`,
    ...report.usage.dead_notes.map((note) => `- ${note.note_id}: ${note.title}`),
    `Perpetual candidates (>=${report.usage.perpetual_candidate_min_appearances}): ${report.usage.perpetual_candidates.length}`,
    ...report.usage.perpetual_candidates.map((note) => `- ${note.note_id}: ${note.title} (${note.appearances})`),
    '',
    'Cut-reason mix',
    `Total cut candidates: ${report.cut_reasons.total}`,
    ...cuts.map(([reason, value]) => `${reason}: ${value.count} (${percent(value.rate)})`),
  ].join('\n') + '\n';
}
