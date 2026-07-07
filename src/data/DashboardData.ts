import {
  DashboardData,
  Label,
  LabelSlice,
  Period,
  SessionCost,
  SessionSlice,
  Slice,
  Source,
  TokenBreakdown,
} from "./types";

/** Distinct palette used to color labels in the dashboard charts. */
const PALETTE = [
  "#4e79a7",
  "#f28e2b",
  "#e15759",
  "#76b7b2",
  "#59a14f",
  "#edc948",
  "#b07aa1",
  "#ff9da7",
  "#9c755f",
  "#bab0ac",
];

const UNASSIGNED_COLOR = "#8c8c8c";
const OTHER_COLOR = "#bab0ac";
const TOP_SESSIONS = 15;

/**
 * Sessions costing less than this (USD) are excluded from every dashboard
 * statistic. They are overwhelmingly aborted sessions or one-off test prompts
 * that add noise without meaningfully contributing to spend.
 */
export const MIN_SESSION_COST = 0.03;
const TOP_MODELS = 8;
const TOP_REPOS = 10;

/** Display name and fixed color for each harness (source). */
const HARNESS_META: Record<Source, { name: string; color: string }> = {
  "claude-code": { name: "Claude Code", color: "#d97757" },
  opencode: { name: "OpenCode", color: "#59a14f" },
  copilot: { name: "Copilot", color: "#4e79a7" },
};

/** Periods offered by the dashboard's chart selectors. */
const PERIODS: Period[] = ["thisMonth", "lastMonth", "last3Months", "allTime"];

function round(n: number): number {
  // Cost is in US dollars; round to cents.
  return Math.round(n * 100) / 100;
}

/**
 * The model a session mostly used: the entry in `costByModel` with the highest
 * cost. Falls back to the harness name when a session has no per-model data.
 */
function primaryModel(s: SessionCost): string {
  if (s.costByModel) {
    let best: string | undefined;
    let bestVal = -Infinity;
    for (const [model, cost] of Object.entries(s.costByModel)) {
      if (cost > bestVal) {
        bestVal = cost;
        best = model;
      }
    }
    if (best) {
      return best;
    }
  }
  return HARNESS_META[s.source]?.name ?? s.source;
}

/** Total tokens (all kinds) recorded on a session, or 0 when untracked. */
function totalTokens(s: SessionCost): number {
  const t = s.tokens;
  return t ? t.input + t.output + t.cacheWrite + t.cacheRead : 0;
}

/** Inclusive-start, exclusive-end epoch bounds for a period, based on `now`. */
function periodBounds(period: Period, now: Date): { start: number; end: number } {
  const year = now.getFullYear();
  const month = now.getMonth();
  const monthStart = new Date(year, month, 1).getTime();
  const nextMonthStart = new Date(year, month + 1, 1).getTime();
  switch (period) {
    case "thisMonth":
      return { start: monthStart, end: nextMonthStart };
    case "lastMonth":
      return { start: new Date(year, month - 1, 1).getTime(), end: monthStart };
    case "last3Months":
      return { start: new Date(year, month - 2, 1).getTime(), end: nextMonthStart };
    case "allTime":
      return { start: 0, end: Number.MAX_SAFE_INTEGER };
  }
}

/**
 * Bounds for the window immediately preceding `period` (same length), used to
 * compute the "vs previous" change. Returns null for periods with no
 * comparable predecessor (all time).
 */
function prevPeriodBounds(
  period: Period,
  now: Date
): { start: number; end: number } | null {
  const year = now.getFullYear();
  const month = now.getMonth();
  const monthStart = new Date(year, month, 1).getTime();
  switch (period) {
    case "thisMonth":
      return { start: new Date(year, month - 1, 1).getTime(), end: monthStart };
    case "lastMonth":
      return {
        start: new Date(year, month - 2, 1).getTime(),
        end: new Date(year, month - 1, 1).getTime(),
      };
    case "last3Months":
      // The 3 months before the current 3-month window (months m-5..m-3).
      return {
        start: new Date(year, month - 5, 1).getTime(),
        end: new Date(year, month - 2, 1).getTime(),
      };
    case "allTime":
      return null;
  }
}

function filterByBounds(
  sessions: SessionCost[],
  bounds: { start: number; end: number }
): SessionCost[] {
  return sessions.filter(
    (s) => s.timestamp >= bounds.start && s.timestamp < bounds.end
  );
}

function filterByPeriod(
  sessions: SessionCost[],
  period: Period,
  now: Date
): SessionCost[] {
  const { start, end } = periodBounds(period, now);
  return sessions.filter((s) => s.timestamp >= start && s.timestamp < end);
}

/**
 * Builds the aggregated {@link DashboardData} payload from the loaded sessions
 * and the user's labels + assignments.
 */
export function buildDashboardData(
  sessions: SessionCost[],
  labels: Label[],
  assignments: Record<string, string>,
  now: Date = new Date()
): DashboardData {
  // Drop trivially-cheap sessions (aborted / quick test prompts) up front so
  // they cannot skew any downstream statistic.
  sessions = sessions.filter((s) => s.totalCredits >= MIN_SESSION_COST);

  // --- Shared label → color map (single source of truth for both charts) --
  const colorById = new Map<string, string>();
  labels.forEach((label, i) => {
    colorById.set(label.id, label.color ?? PALETTE[i % PALETTE.length]);
  });
  colorById.set("__unassigned__", UNASSIGNED_COLOR);

  const colorForSession = (sessionId: string): string => {
    const labelId = assignments[sessionId];
    const key = labelId && colorById.has(labelId) ? labelId : "__unassigned__";
    return colorById.get(key) ?? UNASSIGNED_COLOR;
  };

  const labelById = new Map(labels.map((l) => [l.id, l]));

  // --- Stable model → color map (consistent across all model charts) -----
  // Rank models by all-time total cost so a model keeps the same color
  // regardless of which per-model chart or period is shown.
  const modelTotals = new Map<string, number>();
  for (const s of sessions) {
    if (s.costByModel) {
      for (const [model, cost] of Object.entries(s.costByModel)) {
        modelTotals.set(model, (modelTotals.get(model) ?? 0) + cost);
      }
    }
  }
  const modelColor = new Map<string, string>();
  [...modelTotals.entries()]
    .sort((a, b) => b[1] - a[1])
    .forEach(([model], i) => modelColor.set(model, PALETTE[i % PALETTE.length]));
  const colorForModel = (model: string): string =>
    modelColor.get(model) ?? OTHER_COLOR;

  // --- Per session (top N by credits), computed per period ---------------
  const buildPerSession = (subset: SessionCost[]): SessionSlice[] =>
    [...subset]
      .filter((s) => s.totalCredits > 0)
      .sort((a, b) => b.totalCredits - a.totalCredits)
      .slice(0, TOP_SESSIONS)
      .map((s) => ({
        label: s.firstPrompt || s.sessionId.slice(0, 8),
        credits: round(s.totalCredits),
        color: colorForSession(s.sessionId),
      }));

  // --- Per label (including Unassigned), computed per period -------------
  const buildPerLabel = (subset: SessionCost[]): LabelSlice[] => {
    const totals = new Map<string, number>();
    for (const s of subset) {
      const labelId = assignments[s.sessionId];
      const key =
        labelId && labelById.has(labelId) ? labelId : "__unassigned__";
      totals.set(key, (totals.get(key) ?? 0) + s.totalCredits);
    }

    const result: LabelSlice[] = [];
    labels.forEach((label) => {
      const credits = totals.get(label.id) ?? 0;
      if (credits > 0) {
        result.push({
          name: label.name,
          credits: round(credits),
          color: colorById.get(label.id) ?? UNASSIGNED_COLOR,
        });
      }
    });
    const unassigned = totals.get("__unassigned__") ?? 0;
    if (unassigned > 0) {
      result.push({
        name: "Unassigned",
        credits: round(unassigned),
        color: UNASSIGNED_COLOR,
      });
    }
    result.sort((a, b) => b.credits - a.credits);
    return result;
  };

  // --- Per harness (source), computed per period -------------------------
  const buildPerHarness = (subset: SessionCost[]): Slice[] => {
    const totals = new Map<Source, number>();
    for (const s of subset) {
      totals.set(s.source, (totals.get(s.source) ?? 0) + s.totalCredits);
    }
    const result: Slice[] = [];
    for (const [source, credits] of totals) {
      if (credits <= 0) {
        continue;
      }
      const meta = HARNESS_META[source];
      result.push({
        name: meta?.name ?? source,
        credits: round(credits),
        color: meta?.color ?? OTHER_COLOR,
      });
    }
    result.sort((a, b) => b.credits - a.credits);
    return result;
  };

  // --- Generic top-N breakdown (models, repos) with an "Other" bucket -----
  const buildTopSlices = (totals: Map<string, number>, topN: number): Slice[] => {
    const sorted = [...totals.entries()]
      .filter(([, credits]) => credits > 0)
      .sort((a, b) => b[1] - a[1]);
    const top = sorted.slice(0, topN);
    const rest = sorted.slice(topN);
    const slices: Slice[] = top.map(([name, credits], i) => ({
      name,
      credits: round(credits),
      color: PALETTE[i % PALETTE.length],
    }));
    const otherTotal = rest.reduce((sum, [, c]) => sum + c, 0);
    if (otherTotal > 0) {
      slices.push({ name: "Other", credits: round(otherTotal), color: OTHER_COLOR });
    }
    return slices;
  };

  const buildPerModel = (subset: SessionCost[]): Slice[] => {
    const totals = new Map<string, number>();
    for (const s of subset) {
      if (s.costByModel) {
        for (const [model, credits] of Object.entries(s.costByModel)) {
          totals.set(model, (totals.get(model) ?? 0) + credits);
        }
      } else if (s.totalCredits > 0) {
        // No per-model data (e.g. legacy cache): bucket under the harness name.
        const name = HARNESS_META[s.source]?.name ?? s.source;
        totals.set(name, (totals.get(name) ?? 0) + s.totalCredits);
      }
    }
    return buildTopSlices(totals, TOP_MODELS);
  };

  const buildPerRepo = (subset: SessionCost[]): Slice[] => {
    const totals = new Map<string, number>();
    for (const s of subset) {
      const name = s.workspaceName || "Unknown";
      totals.set(name, (totals.get(name) ?? 0) + s.totalCredits);
    }
    return buildTopSlices(totals, TOP_REPOS);
  };

  // --- Token breakdown, computed per period ------------------------------
  const buildTokens = (subset: SessionCost[]): TokenBreakdown => {
    const acc: TokenBreakdown = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
    for (const s of subset) {
      if (s.tokens) {
        acc.input += s.tokens.input;
        acc.output += s.tokens.output;
        acc.cacheWrite += s.tokens.cacheWrite;
        acc.cacheRead += s.tokens.cacheRead;
      }
    }
    return acc;
  };

  // --- Spend heatmap (weekday × hour), computed per period ---------------
  // Weekday index is Monday-based (0 = Monday … 6 = Sunday).
  const buildActivity = (subset: SessionCost[]): number[] => {
    const grid = new Array(7 * 24).fill(0);
    for (const s of subset) {
      if (s.totalCredits <= 0) {
        continue;
      }
      const d = new Date(s.timestamp);
      const weekday = (d.getDay() + 6) % 7; // Sun(0)->6, Mon(1)->0, …
      const idx = weekday * 24 + d.getHours();
      grid[idx] += s.totalCredits;
    }
    return grid.map((v) => round(v));
  };

  // --- Average cost per session by harness -------------------------------
  const buildAvgCostByHarness = (subset: SessionCost[]): Slice[] => {
    const agg = new Map<Source, { sum: number; count: number }>();
    for (const s of subset) {
      if (s.totalCredits <= 0) {
        continue;
      }
      const cur = agg.get(s.source) ?? { sum: 0, count: 0 };
      cur.sum += s.totalCredits;
      cur.count += 1;
      agg.set(s.source, cur);
    }
    const result: Slice[] = [];
    for (const [source, { sum, count }] of agg) {
      const meta = HARNESS_META[source];
      result.push({
        name: meta?.name ?? source,
        credits: round(sum / count),
        color: meta?.color ?? OTHER_COLOR,
      });
    }
    result.sort((a, b) => b.credits - a.credits);
    return result;
  };

  // --- Per (primary) model averages and counts ---------------------------
  // `value(s)` selects what each session contributes; results are averaged
  // (avgCost/avgTokens) or summed as a count.
  const buildByModel = (
    subset: SessionCost[],
    value: (s: SessionCost) => number,
    mode: "avg" | "count",
    // For averages, whether sessions whose value is 0 still count towards the
    // denominator (e.g. subagents-per-session includes sessions with none).
    includeZero = false
  ): Slice[] => {
    const agg = new Map<string, { sum: number; count: number }>();
    for (const s of subset) {
      if (s.totalCredits <= 0) {
        continue;
      }
      const v = value(s);
      if (mode === "avg" && v <= 0 && !includeZero) {
        continue; // don't dilute averages with sessions lacking the metric
      }
      const key = primaryModel(s);
      const cur = agg.get(key) ?? { sum: 0, count: 0 };
      cur.sum += v;
      cur.count += 1;
      agg.set(key, cur);
    }
    const slices: Slice[] = [];
    for (const [name, { sum, count }] of agg) {
      const metric = mode === "avg" ? sum / count : count;
      slices.push({ name, credits: round(metric), color: colorForModel(name) });
    }
    slices.sort((a, b) => b.credits - a.credits);
    return slices.slice(0, TOP_MODELS);
  };

  // --- Number of sessions by label (incl. Unassigned) --------------------
  const buildSessionsByLabel = (subset: SessionCost[]): Slice[] => {
    const counts = new Map<string, number>();
    for (const s of subset) {
      if (s.totalCredits <= 0) {
        continue;
      }
      const labelId = assignments[s.sessionId];
      const key =
        labelId && labelById.has(labelId) ? labelId : "__unassigned__";
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const result: Slice[] = [];
    labels.forEach((label) => {
      const count = counts.get(label.id) ?? 0;
      if (count > 0) {
        result.push({
          name: label.name,
          credits: count,
          color: colorById.get(label.id) ?? UNASSIGNED_COLOR,
        });
      }
    });
    const unassigned = counts.get("__unassigned__") ?? 0;
    if (unassigned > 0) {
      result.push({
        name: "Unassigned",
        credits: unassigned,
        color: UNASSIGNED_COLOR,
      });
    }
    result.sort((a, b) => b.credits - a.credits);
    return result;
  };

  const sumCost = (subset: SessionCost[]): number =>
    subset.reduce((acc, s) => acc + s.totalCredits, 0);

  const perSession = {} as Record<Period, SessionSlice[]>;
  const perLabel = {} as Record<Period, LabelSlice[]>;
  const perHarness = {} as Record<Period, Slice[]>;
  const perModel = {} as Record<Period, Slice[]>;
  const perRepo = {} as Record<Period, Slice[]>;
  const tokens = {} as Record<Period, TokenBreakdown>;
  const activity = {} as Record<Period, number[]>;
  const avgCostByHarness = {} as Record<Period, Slice[]>;
  const avgCostByModel = {} as Record<Period, Slice[]>;
  const avgTokensByModel = {} as Record<Period, Slice[]>;
  const sessionsByModel = {} as Record<Period, Slice[]>;
  const avgSubagentsByModel = {} as Record<Period, Slice[]>;
  const sessionsByLabel = {} as Record<Period, Slice[]>;
  const kpis = {} as Record<Period, DashboardData["kpis"][Period]>;
  for (const period of PERIODS) {
    const subset = filterByPeriod(sessions, period, now);
    perSession[period] = buildPerSession(subset);
    perLabel[period] = buildPerLabel(subset);
    perHarness[period] = buildPerHarness(subset);
    perModel[period] = buildPerModel(subset);
    perRepo[period] = buildPerRepo(subset);
    tokens[period] = buildTokens(subset);
    activity[period] = buildActivity(subset);
    avgCostByHarness[period] = buildAvgCostByHarness(subset);
    avgCostByModel[period] = buildByModel(subset, (s) => s.totalCredits, "avg");
    avgTokensByModel[period] = buildByModel(subset, totalTokens, "avg");
    sessionsByModel[period] = buildByModel(subset, () => 1, "count");
    avgSubagentsByModel[period] = buildByModel(
      subset,
      (s) => s.subagentCount ?? 0,
      "avg",
      true
    );
    sessionsByLabel[period] = buildSessionsByLabel(subset);

    // Headline KPIs, scoped to the period so they follow the filter.
    const cost = sumCost(subset);
    const paidSessions = subset.filter((s) => s.totalCredits > 0).length;
    const prevBounds = prevPeriodBounds(period, now);
    const prevCost = prevBounds
      ? sumCost(filterByBounds(sessions, prevBounds))
      : 0;
    kpis[period] = {
      cost: round(cost),
      percentChange:
        prevBounds && prevCost > 0
          ? round(((cost - prevCost) / prevCost) * 100)
          : null,
      activeLabels: perLabel[period].filter((l) => l.name !== "Unassigned")
        .length,
      avgCostPerSession: paidSessions > 0 ? round(cost / paidSessions) : 0,
    };
  }

  // --- Monthly timeseries (cumulative, current month) --------------------
  const year = now.getFullYear();
  const month = now.getMonth();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const perDay = new Array(daysInMonth + 1).fill(0); // 1-indexed

  const prevMonth = month === 0 ? 11 : month - 1;
  const prevYear = month === 0 ? year - 1 : year;
  const daysInPrevMonth = new Date(prevYear, prevMonth + 1, 0).getDate();
  const prevPerDay = new Array(daysInPrevMonth + 1).fill(0); // 1-indexed

  for (const s of sessions) {
    const d = new Date(s.timestamp);
    if (d.getFullYear() === year && d.getMonth() === month) {
      perDay[d.getDate()] += s.totalCredits;
    } else if (d.getFullYear() === prevYear && d.getMonth() === prevMonth) {
      prevPerDay[d.getDate()] += s.totalCredits;
    }
  }

  const monthly: DashboardData["monthly"] = [];
  let cumulative = 0;
  // Only plot up to the current day; leave the rest of the month blank
  // instead of flatlining where there is no data yet.
  const lastDay = year === now.getFullYear() && month === now.getMonth()
    ? now.getDate()
    : daysInMonth;
  for (let day = 1; day <= lastDay; day++) {
    cumulative += perDay[day];
    monthly.push({ day, cumulative: round(cumulative) });
  }

  // Full previous month, cumulative per day, for comparison.
  const prevMonthly: DashboardData["prevMonthly"] = [];
  let prevCumulative = 0;
  for (let day = 1; day <= daysInPrevMonth; day++) {
    prevCumulative += prevPerDay[day];
    prevMonthly.push({ day, cumulative: round(prevCumulative) });
  }

  const monthLabel = now.toLocaleString(undefined, {
    month: "long",
    year: "numeric",
  });
  const prevMonthLabel = new Date(prevYear, prevMonth, 1).toLocaleString(
    undefined,
    { month: "long", year: "numeric" },
  );

  const periodLabels: Record<Period, string> = {
    thisMonth: "This month",
    lastMonth: "Last month",
    last3Months: "Last 3 months",
    allTime: "All time",
  };

  return {
    perSession,
    perLabel,
    perHarness,
    perModel,
    perRepo,
    tokens,
    activity,
    avgCostByHarness,
    avgCostByModel,
    avgTokensByModel,
    sessionsByModel,
    avgSubagentsByModel,
    sessionsByLabel,
    monthly,
    prevMonthly,
    prevMonthLabel,
    kpis,
    periodLabels,
    monthLabel,
  };
}
