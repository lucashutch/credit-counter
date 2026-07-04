import * as assert from "assert";
import { buildDashboardData } from "../../src/data/DashboardData";
import { Label, SessionCost } from "../../src/data/types";

function session(
  id: string,
  credits: number,
  timestamp: number,
  firstPrompt = id
): SessionCost {
  return {
    sessionId: id,
    workspaceHash: "w",
    firstPrompt,
    timestamp,
    totalCredits: credits,
  };
}

// Reference "now": 15 June 2026.
const NOW = new Date(2026, 5, 15, 12, 0, 0);
const ms = (y: number, m: number, d: number) => new Date(y, m, d, 10).getTime();

describe("buildDashboardData", () => {
  const labels: Label[] = [
    { id: "L1", name: "Alpha" },
    { id: "L2", name: "Beta" },
  ];

  it("aggregates per-label totals including an Unassigned bucket", () => {
    const sessions = [
      session("s1", 100, ms(2026, 5, 2)),
      session("s2", 50, ms(2026, 5, 3)),
      session("s3", 30, ms(2026, 5, 4)),
    ];
    const assignments = { s1: "L1", s2: "L1" }; // s3 unassigned
    const data = buildDashboardData(sessions, labels, assignments, NOW);

    const byName = Object.fromEntries(
      data.perLabel.allTime.map((l) => [l.name, l.credits])
    );
    assert.strictEqual(byName["Alpha"], 150);
    assert.strictEqual(byName["Unassigned"], 30);
    assert.strictEqual(byName["Beta"], undefined); // no credits -> omitted
  });

  it("colors each session the same as its label", () => {
    const sessions = [session("s1", 100, ms(2026, 5, 2))];
    const assignments = { s1: "L1" };
    const data = buildDashboardData(sessions, labels, assignments, NOW);

    const labelColor = data.perLabel.allTime.find((l) => l.name === "Alpha")?.color;
    const sessionColor = data.perSession.allTime[0].color;
    assert.strictEqual(sessionColor, labelColor);
  });

  it("uses the unassigned color for sessions without a label", () => {
    const sessions = [session("s1", 100, ms(2026, 5, 2))];
    const data = buildDashboardData(sessions, labels, {}, NOW);
    const unassignedColor = data.perLabel.allTime.find(
      (l) => l.name === "Unassigned"
    )?.color;
    assert.strictEqual(data.perSession.allTime[0].color, unassignedColor);
  });

  it("builds a cumulative monthly series for the current month", () => {
    const sessions = [
      session("s1", 10, ms(2026, 5, 1)),
      session("s2", 20, ms(2026, 5, 1)),
      session("s3", 5, ms(2026, 5, 3)),
    ];
    const data = buildDashboardData(sessions, labels, {}, NOW);

    assert.strictEqual(data.monthly.length, 15); // stops at current day (June 15)
    assert.strictEqual(data.monthly[0].cumulative, 30); // day 1: 10 + 20
    assert.strictEqual(data.monthly[1].cumulative, 30); // day 2: no change
    assert.strictEqual(data.monthly[2].cumulative, 35); // day 3: +5
    assert.strictEqual(data.monthly[14].cumulative, 35); // current day (15th)
  });

  it("computes percent change versus the previous month", () => {
    const sessions = [
      session("prev", 100, ms(2026, 4, 10)), // May (prev month)
      session("cur", 150, ms(2026, 5, 10)), // June (current)
    ];
    const data = buildDashboardData(sessions, labels, {}, NOW);
    assert.strictEqual(data.kpis.monthCredits, 150);
    assert.strictEqual(data.kpis.prevMonthCredits, 100);
    assert.strictEqual(data.kpis.percentChange, 50);
  });

  it("reports null percent change when there is no previous-month data", () => {
    const sessions = [session("cur", 150, ms(2026, 5, 10))];
    const data = buildDashboardData(sessions, labels, {}, NOW);
    assert.strictEqual(data.kpis.percentChange, null);
  });

  it("limits per-session list to the top 15 by credits", () => {
    const sessions = Array.from({ length: 20 }, (_, i) =>
      session("s" + i, i + 1, ms(2026, 5, 2))
    );
    const data = buildDashboardData(sessions, labels, {}, NOW);
    assert.strictEqual(data.perSession.allTime.length, 15);
    assert.strictEqual(data.perSession.allTime[0].credits, 20); // most expensive first
  });

  it("excludes zero-credit sessions from the per-session list", () => {
    const sessions = [
      session("s1", 0, ms(2026, 5, 2)),
      session("s2", 5, ms(2026, 5, 2)),
    ];
    const data = buildDashboardData(sessions, labels, {}, NOW);
    assert.strictEqual(data.perSession.allTime.length, 1);
    assert.strictEqual(data.perSession.allTime[0].label, "s2");
  });

  it("filters the per-label and per-session charts by period", () => {
    const sessions = [
      session("thisMo", 10, ms(2026, 5, 5)), // June (this month)
      session("lastMo", 20, ms(2026, 4, 5)), // May (last month)
      session("threeMo", 30, ms(2026, 3, 5)), // April (within last 3 months)
      session("old", 40, ms(2026, 0, 5)), // January (all time only)
    ];
    const data = buildDashboardData(sessions, labels, {}, NOW);

    const ids = (slices: { label: string }[]) => slices.map((s) => s.label).sort();

    assert.deepStrictEqual(ids(data.perSession.thisMonth), ["thisMo"]);
    assert.deepStrictEqual(ids(data.perSession.lastMonth), ["lastMo"]);
    assert.deepStrictEqual(ids(data.perSession.last3Months), [
      "lastMo",
      "thisMo",
      "threeMo",
    ]);
    assert.deepStrictEqual(ids(data.perSession.allTime), [
      "lastMo",
      "old",
      "thisMo",
      "threeMo",
    ]);

    assert.strictEqual(data.perLabel.thisMonth[0].credits, 10);
    assert.strictEqual(data.perLabel.allTime[0].credits, 100);
  });
});
