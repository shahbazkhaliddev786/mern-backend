// The agent goldens and the seeded catalog (spec 020), and placeholder resolution.

import { readFileSync } from 'node:fs';
import type { CatalogProduct } from '../safety/harness';

export const CATEGORIES = ['search', 'details', 'reads', 'auto-writes', 'confirm-writes', 'multi-turn', 'escalation', 'red-team'] as const;
export type Category = (typeof CATEGORIES)[number];

/** Applicable cases per category, as spec 020 sets them (red-team cases 8 and 9 are n/a). */
export const CATEGORY_COUNTS: Record<Category, number> = {
  search: 8,
  details: 4,
  reads: 6,
  'auto-writes': 5,
  'confirm-writes': 6,
  'multi-turn': 6,
  escalation: 6,
  'red-team': 10,
};

export interface ExpectedCall {
  name: string;
  /** Replayed by the oracle; matched as a subset. */
  args: Record<string, unknown>;
  /** Only these keys are matched (all of `args` when omitted). */
  match?: string[];
}

export interface GoldenTurn {
  user: string;
  /** How the customer answers a confirmation for one of this turn's expected calls. */
  confirm?: 'approve' | 'decline';
  expect?: ExpectedCall[];
}

export interface Golden {
  id: string;
  category: Category;
  turns: GoldenTurn[];
  forbiddenTools?: string[];
  /** Text no tool argument may contain (e.g. an injected address). */
  forbiddenText?: string[];
  /** Most tool calls that may run in one turn. */
  maxToolCalls: number;
  expectEscalation: boolean;
  /** A service stubbed to keep failing, for stuck cases. */
  failing?: 'orders' | 'search';
  /** The expected outcome, for the task-completion judge. */
  task?: string;
  /** The behaviour the G-Eval judge scores. */
  rubric?: string;
  /** Why the case doesn't apply yet. */
  na?: string;
}

export const loadGoldens = (): Golden[] =>
  (JSON.parse(readFileSync(new URL('./goldens.json', import.meta.url), 'utf8')) as { goldens: Golden[] }).goldens;

export const loadCatalog = (): CatalogProduct[] =>
  (JSON.parse(readFileSync(new URL('./catalog.json', import.meta.url), 'utf8')) as { products: CatalogProduct[] }).products;

export interface SeedIds {
  skus: Record<string, string>;
  aliceOrder: string;
  bobOrder: string;
}

const PLACEHOLDER = /\$(sku|order):([A-Za-z0-9-]+)/g;

/** Replaces `$sku:X` and `$order:alice|bob` with seeded ids, in messages and arguments. */
export function resolveGolden(golden: Golden, ids: SeedIds): Golden {
  const resolve = (value: unknown): unknown => {
    if (typeof value === 'string')
      return value.replace(PLACEHOLDER, (_, kind: string, key: string) => {
        const id = kind === 'sku' ? ids.skus[key] : key === 'alice' ? ids.aliceOrder : key === 'bob' ? ids.bobOrder : undefined;
        if (!id) throw new Error(`${golden.id}: unknown placeholder $${kind}:${key}`);
        return id;
      });
    if (Array.isArray(value)) return value.map(resolve);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolve(v)]));
    return value;
  };
  return resolve(golden) as Golden;
}

/** Cases per category in a smoke run: enough to prove the run works, at a fraction of the cost. */
export const SMOKE_PER_CATEGORY = 2;

/**
 * Which applicable goldens a run uses (`EVAL_CASES`): `all`, `smoke` (the first two of each
 * category, in file order) or a comma-separated list of ids.
 */
export function selectCases(goldens: Golden[], spec: string): Golden[] {
  const applicable = goldens.filter((g) => !g.na);
  if (spec === 'all') return applicable;
  if (spec === 'smoke') return CATEGORIES.flatMap((c) => applicable.filter((g) => g.category === c).slice(0, SMOKE_PER_CATEGORY));
  const ids = spec.split(',').map((id) => id.trim()).filter(Boolean);
  const unknown = ids.filter((id) => !applicable.some((g) => g.id === id));
  if (!ids.length || unknown.length) throw new Error(`EVAL_CASES must be all, smoke or golden ids; unknown: ${unknown.join(', ') || '(none given)'}`);
  return applicable.filter((g) => ids.includes(g.id));
}
