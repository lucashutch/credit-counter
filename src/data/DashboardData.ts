import {
  DashboardData,
  Label,
  LabelSlice,
  Period,
  SessionCost,
  SessionSlice,
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
const TOP_SESSIONS = 15;

/** Periods offered by the dashboard's chart selectors. */
const PERIODS: Period[] = ["thisMonth", "lastMonth", "last3Months", "allTime"];

function round(n: number): number {
  return Math.round(n * 10) / 10;
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

  const perSession = {} as Record<Period, SessionSlice[]>;
  const perLabel = {} as Record<Period, LabelSlice[]>;
  for (const period of PERIODS) {
    const subset = filterByPeriod(sessions, period, now);
    perSession[period] = buildPerSession(subset);
    perLabel[period] = buildPerLabel(subset);
  }

  // --- Monthly timeseries (cumulative, current month) --------------------
  const year = now.getFullYear();
  const month = now.getMonth();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const perDay = new Array(daysInMonth + 1).fill(0); // 1-indexed

  let monthCredits = 0;
  let prevMonthCredits = 0;
  const prevMonth = month === 0 ? 11 : month - 1;
  const prevYear = month === 0 ? year - 1 : year;
  const daysInPrevMonth = new Date(prevYear, prevMonth + 1, 0).getDate();
  const prevPerDay = new Array(daysInPrevMonth + 1).fill(0); // 1-indexed

  for (const s of sessions) {
    const d = new Date(s.timestamp);
    if (d.getFullYear() === year && d.getMonth() === month) {
      perDay[d.getDate()] += s.totalCredits;
      monthCredits += s.totalCredits;
    } else if (d.getFullYear() === prevYear && d.getMonth() === prevMonth) {
      prevPerDay[d.getDate()] += s.totalCredits;
      prevMonthCredits += s.totalCredits;
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

  // --- KPIs --------------------------------------------------------------
  const totalCredits = round(sessions.reduce((s, x) => s + x.totalCredits, 0));
  const percentChange =
    prevMonthCredits > 0
      ? round(((monthCredits - prevMonthCredits) / prevMonthCredits) * 100)
      : null;

  const monthLabel = now.toLocaleString(undefined, {
    month: "long",
    year: "numeric",
  });
  const prevMonthLabel = new Date(prevYear, prevMonth, 1).toLocaleString(
    undefined,
    { month: "long", year: "numeric" },
  );

  return {
    perSession,
    perLabel,
    monthly,
    prevMonthly,
    prevMonthLabel,
    kpis: {
      totalCredits,
      activeLabels: perLabel.allTime.filter((l) => l.name !== "Unassigned")
        .length,
      monthCredits: round(monthCredits),
      prevMonthCredits: round(prevMonthCredits),
      percentChange,
    },
    monthLabel,
  };
}
