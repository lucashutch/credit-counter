import { DashboardData, Label, SessionCost } from "./types";

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

function round(n: number): number {
  return Math.round(n * 10) / 10;
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
  // --- Per session (top N by credits) ------------------------------------
  const perSession = [...sessions]
    .filter((s) => s.totalCredits > 0)
    .sort((a, b) => b.totalCredits - a.totalCredits)
    .slice(0, TOP_SESSIONS)
    .map((s) => ({
      label: s.firstPrompt || s.sessionId.slice(0, 8),
      credits: round(s.totalCredits),
    }));

  // --- Per label (including Unassigned) ----------------------------------
  const labelById = new Map(labels.map((l) => [l.id, l]));
  const totals = new Map<string, number>();
  for (const s of sessions) {
    const labelId = assignments[s.sessionId];
    const key = labelId && labelById.has(labelId) ? labelId : "__unassigned__";
    totals.set(key, (totals.get(key) ?? 0) + s.totalCredits);
  }

  const perLabel: DashboardData["perLabel"] = [];
  labels.forEach((label, i) => {
    const credits = totals.get(label.id) ?? 0;
    if (credits > 0) {
      perLabel.push({
        name: label.name,
        credits: round(credits),
        color: label.color ?? PALETTE[i % PALETTE.length],
      });
    }
  });
  const unassigned = totals.get("__unassigned__") ?? 0;
  if (unassigned > 0) {
    perLabel.push({
      name: "Unassigned",
      credits: round(unassigned),
      color: UNASSIGNED_COLOR,
    });
  }
  perLabel.sort((a, b) => b.credits - a.credits);

  // --- Monthly timeseries (cumulative, current month) --------------------
  const year = now.getFullYear();
  const month = now.getMonth();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const perDay = new Array(daysInMonth + 1).fill(0); // 1-indexed

  let monthCredits = 0;
  let prevMonthCredits = 0;
  const prevMonth = month === 0 ? 11 : month - 1;
  const prevYear = month === 0 ? year - 1 : year;

  for (const s of sessions) {
    const d = new Date(s.timestamp);
    if (d.getFullYear() === year && d.getMonth() === month) {
      perDay[d.getDate()] += s.totalCredits;
      monthCredits += s.totalCredits;
    } else if (d.getFullYear() === prevYear && d.getMonth() === prevMonth) {
      prevMonthCredits += s.totalCredits;
    }
  }

  const monthly: DashboardData["monthly"] = [];
  let cumulative = 0;
  for (let day = 1; day <= daysInMonth; day++) {
    cumulative += perDay[day];
    monthly.push({ day, cumulative: round(cumulative) });
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

  return {
    perSession,
    perLabel,
    monthly,
    kpis: {
      totalCredits,
      activeLabels: perLabel.filter((l) => l.name !== "Unassigned").length,
      monthCredits: round(monthCredits),
      prevMonthCredits: round(prevMonthCredits),
      percentChange,
    },
    monthLabel,
  };
}
