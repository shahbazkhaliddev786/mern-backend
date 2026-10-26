// The agent suite's report (spec 020): one table per setup, the comparison and the verdict.

import { CATEGORIES, CATEGORY_COUNTS } from './goldens';
import { categoryResult, completed, costOf, percentile, THRESHOLDS, verdict, type CaseResult, type SetupSummary, type Usage } from './score';

export interface SetupRun {
  setup: string;
  /** The model behind each graph role. */
  models: { agent: string; escalation?: string };
  results: CaseResult[];
  /** Agent plus judge tokens. */
  tokens: number;
  budget: number;
  /** Cases not run once the budget ran out. */
  skipped: string[];
}

/** Disagreements between the Opus judge and the Sonnet cross-check over this gap are flagged (evals.md §10). */
export const JUDGE_GAP = 0.1;

export const agentCost = (run: SetupRun, r: CaseResult) =>
  (Object.entries(r.run.usage) as [keyof typeof run.models, Usage][]).reduce((sum, [role, usage]) => sum + costOf(usage, run.models[role] ?? run.models.agent), 0);

export function summarize(run: SetupRun): SetupSummary & { categories: ReturnType<typeof categoryResult>[] } {
  const categories = CATEGORIES.map((c) => categoryResult(c, run.results, CATEGORY_COUNTS[c], run.results));
  const done = run.results.filter(completed).length;
  const cost = run.results.reduce((sum, r) => sum + agentCost(run, r), 0);
  return {
    setup: run.setup,
    meetsAll: categories.every((c) => c.meets),
    gaps: categories.flatMap((c) => c.gaps),
    costPerCompleted: done ? cost / done : Number.POSITIVE_INFINITY,
    p95Ms: percentile(
      run.results.map((r) => r.run.ms),
      95,
    ),
    categories,
  };
}

const n = (value: number | undefined, digits = 2) => (value === undefined ? '—' : value.toFixed(digits));

export function renderReport(runs: SetupRun[], options?: { judge: { name: string; model: string; provisional: boolean }; cases: string }): string {
  const summaries = runs.map(summarize);
  const v = verdict(summaries);
  const lines = ['# Agent suite — last run', '', `${new Date().toISOString()} · setups: ${runs.map((r) => r.setup).join(', ')}${options ? ` · cases: ${options.cases} · judge: ${options.judge.model}` : ''}`, ''];
  if (options?.judge.provisional)
    lines.push('> **Provisional:** a cheap run. Sonnet judged Sonnet-written turns (self-graded), so the judged scores and the verdict need a run with `judge=opus` and `cases=all` to count.', '');
  runs.forEach((run, i) => {
    const s = summaries[i]!;
    const ms = run.results.map((r) => r.run.ms);
    lines.push(
      `## ${run.setup} (${run.models.agent}${run.models.escalation ? ` + ${run.models.escalation} escalation` : ''})`,
      '',
      `${run.results.length} cases · ${run.results.filter(completed).length} completed · agent cost $${run.results.reduce((sum, r) => sum + agentCost(run, r), 0).toFixed(4)} · $${n(s.costPerCompleted, 4)} per completed task · tokens ${run.tokens.toLocaleString('en-US')} of ${run.budget.toLocaleString('en-US')} · p50 ${Math.round(percentile(ms, 50))} ms · p95 ${Math.round(s.p95Ms)} ms`,
      '',
      '| Category | Cases | Pass rate | Needs | Judged | Needs | Meets |',
      '|---|---|---|---|---|---|---|',
      ...s.categories.map((c) => {
        const t = THRESHOLDS[c.category];
        const pass = c.escalationPrecision !== undefined ? `${n(c.passRate)} (precision ${n(c.escalationPrecision)})` : n(c.passRate);
        return `| ${c.category} | ${c.cases}/${c.planned} | ${pass} | ${t.deterministic ?? (c.category === 'escalation' ? 'precision 0.9' : '—')} | ${n(c.judgedMean)} | ${t.judged ?? '—'} | ${c.meets ? 'yes' : 'no'} |`;
      }),
      '',
    );
    const failures = run.results.filter((r) => !completed(r));
    if (failures.length) {
      lines.push('**Not completed:**', '');
      for (const r of failures) {
        const why = r.checks.filter((c) => !c.pass).map((c) => `${c.check}: ${c.why}`);
        if (r.judged !== undefined) why.push(`judged ${n(r.judged)}`);
        lines.push(`- ${r.golden.id}: ${why.join('; ')}`);
      }
      lines.push('');
    }
    const gaps = run.results.filter((r) => r.crossJudged !== undefined && Math.abs(r.crossJudged - (r.judged ?? 0)) > JUDGE_GAP);
    if (gaps.length) lines.push('**Judges disagree (Opus vs Sonnet, gap over 0.1):**', '', ...gaps.map((r) => `- ${r.golden.id}: ${n(r.judged)} vs ${n(r.crossJudged)}`), '');
    if (run.skipped.length) lines.push(`**Not run (token budget reached):** ${run.skipped.join(', ')}`, '');
  });
  lines.push('## Verdict', '', `**${v.winner}** — ${v.reason}`, '');
  return lines.join('\n');
}
