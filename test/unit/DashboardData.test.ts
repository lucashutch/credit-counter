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
    source: "copilot",
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

  it("computes this-month cost and percent change versus last month", () => {
    const sessions = [
      session("prev", 100, ms(2026, 4, 10)), // May (prev month)
      session("cur", 150, ms(2026, 5, 10)), // June (current)
    ];
    const data = buildDashboardData(sessions, labels, {}, NOW);
    assert.strictEqual(data.kpis.thisMonth.cost, 150);
    assert.strictEqual(data.kpis.thisMonth.percentChange, 50);
  });

  it("reports null percent change when there is no previous-window data", () => {
    const sessions = [session("cur", 150, ms(2026, 5, 10))];
    const data = buildDashboardData(sessions, labels, {}, NOW);
    assert.strictEqual(data.kpis.thisMonth.percentChange, null);
    assert.strictEqual(data.kpis.allTime.percentChange, null);
  });

  it("scopes headline KPIs to the selected period", () => {
    const sessions = [
      session("thisMo", 10, ms(2026, 5, 5)), // June
      session("lastMo", 20, ms(2026, 4, 5)), // May
      session("threeMo", 30, ms(2026, 3, 5)), // April
    ];
    const data = buildDashboardData(sessions, labels, {}, NOW);
    assert.strictEqual(data.kpis.thisMonth.cost, 10);
    assert.strictEqual(data.kpis.lastMonth.cost, 20);
    assert.strictEqual(data.kpis.last3Months.cost, 60);
    assert.strictEqual(data.kpis.allTime.cost, 60);
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

  it("aggregates cost per harness (source)", () => {
    const sessions: SessionCost[] = [
      { ...session("s1", 10, ms(2026, 5, 2)), source: "copilot" },
      { ...session("s2", 20, ms(2026, 5, 2)), source: "claude-code" },
      { ...session("s3", 5, ms(2026, 5, 2)), source: "claude-code" },
    ];
    const data = buildDashboardData(sessions, labels, {}, NOW);
    const byName = Object.fromEntries(
      data.perHarness.allTime.map((s) => [s.name, s.credits])
    );
    assert.strictEqual(byName["Claude Code"], 25);
    assert.strictEqual(byName["Copilot"], 10);
  });

  it("aggregates cost per model from costByModel", () => {
    const sessions: SessionCost[] = [
      { ...session("s1", 30, ms(2026, 5, 2)), costByModel: { "Claude Opus 4.8": 20, "Claude Sonnet 5": 10 } },
      { ...session("s2", 10, ms(2026, 5, 2)), costByModel: { "Claude Opus 4.8": 10 } },
    ];
    const data = buildDashboardData(sessions, labels, {}, NOW);
    const byName = Object.fromEntries(
      data.perModel.allTime.map((s) => [s.name, s.credits])
    );
    assert.strictEqual(byName["Claude Opus 4.8"], 30);
    assert.strictEqual(byName["Claude Sonnet 5"], 10);
  });

  it("buckets sessions without costByModel under their harness name", () => {
    const sessions: SessionCost[] = [
      { ...session("s1", 15, ms(2026, 5, 2)), source: "copilot" },
    ];
    const data = buildDashboardData(sessions, labels, {}, NOW);
    assert.strictEqual(data.perModel.allTime[0].name, "Copilot");
    assert.strictEqual(data.perModel.allTime[0].credits, 15);
  });

  it("aggregates cost per repo using workspaceName", () => {
    const sessions: SessionCost[] = [
      { ...session("s1", 10, ms(2026, 5, 2)), workspaceName: "repo-a" },
      { ...session("s2", 25, ms(2026, 5, 2)), workspaceName: "repo-b" },
      { ...session("s3", 5, ms(2026, 5, 2)) }, // no name -> "Unknown"
    ];
    const data = buildDashboardData(sessions, labels, {}, NOW);
    const byName = Object.fromEntries(
      data.perRepo.allTime.map((s) => [s.name, s.credits])
    );
    assert.strictEqual(byName["repo-b"], 25);
    assert.strictEqual(byName["repo-a"], 10);
    assert.strictEqual(byName["Unknown"], 5);
  });

  it("sums token usage per period", () => {
    const withTokens = (id: string, input: number, cacheRead: number): SessionCost => ({
      ...session(id, 10, ms(2026, 5, 2)),
      source: "claude-code",
      tokens: { input, output: 0, cacheWrite: 0, cacheRead },
    });
    const sessions = [withTokens("s1", 100, 300), withTokens("s2", 100, 100)];
    const data = buildDashboardData(sessions, labels, {}, NOW);

    assert.strictEqual(data.tokens.allTime.input, 200);
    assert.strictEqual(data.tokens.allTime.cacheRead, 400);
  });

  it("builds a 168-slot activity grid keyed by weekday and hour", () => {
    // 2 June 2026 is a Tuesday (Monday-based weekday 1); ms() uses hour 10.
    const sessions = [session("s1", 12, ms(2026, 5, 2))];
    const data = buildDashboardData(sessions, labels, {}, NOW);
    assert.strictEqual(data.activity.allTime.length, 168);
    assert.strictEqual(data.activity.allTime[1 * 24 + 10], 12);
  });

  it("computes average cost per paid session", () => {
    const sessions = [
      session("s1", 30, ms(2026, 5, 2)),
      session("s2", 10, ms(2026, 5, 2)),
      session("s3", 0, ms(2026, 5, 2)), // free session excluded from the average
    ];
    const data = buildDashboardData(sessions, labels, {}, NOW);
    assert.strictEqual(data.kpis.allTime.avgCostPerSession, 20);
  });

  it("averages session cost by harness", () => {
    const sessions: SessionCost[] = [
      { ...session("s1", 10, ms(2026, 5, 2)), source: "claude-code" },
      { ...session("s2", 30, ms(2026, 5, 2)), source: "claude-code" },
      { ...session("s3", 5, ms(2026, 5, 2)), source: "copilot" },
    ];
    const data = buildDashboardData(sessions, labels, {}, NOW);
    const byName = Object.fromEntries(
      data.avgCostByHarness.allTime.map((s) => [s.name, s.credits])
    );
    assert.strictEqual(byName["Claude Code"], 20); // (10 + 30) / 2
    assert.strictEqual(byName["Copilot"], 5);
  });

  it("averages session cost and counts sessions by primary model", () => {
    const sessions: SessionCost[] = [
      { ...session("s1", 30, ms(2026, 5, 2)), costByModel: { "Claude Opus 4.8": 25, "Claude Sonnet 5": 5 } },
      { ...session("s2", 10, ms(2026, 5, 2)), costByModel: { "Claude Opus 4.8": 10 } },
      { ...session("s3", 4, ms(2026, 5, 2)), costByModel: { "Claude Sonnet 5": 4 } },
    ];
    const data = buildDashboardData(sessions, labels, {}, NOW);

    const avg = Object.fromEntries(
      data.avgCostByModel.allTime.map((s) => [s.name, s.credits])
    );
    // s1's primary model is Opus (25 > 5), so Opus sessions = s1, s2.
    assert.strictEqual(avg["Claude Opus 4.8"], 20); // (30 + 10) / 2
    assert.strictEqual(avg["Claude Sonnet 5"], 4);

    const counts = Object.fromEntries(
      data.sessionsByModel.allTime.map((s) => [s.name, s.credits])
    );
    assert.strictEqual(counts["Claude Opus 4.8"], 2);
    assert.strictEqual(counts["Claude Sonnet 5"], 1);
  });

  it("averages total tokens per session by primary model", () => {
    const withTokens = (id: string, model: string, input: number): SessionCost => ({
      ...session(id, 10, ms(2026, 5, 2)),
      source: "claude-code",
      costByModel: { [model]: 10 },
      tokens: { input, output: 0, cacheWrite: 0, cacheRead: 0 },
    });
    const sessions = [
      withTokens("s1", "Claude Opus 4.8", 100),
      withTokens("s2", "Claude Opus 4.8", 300),
    ];
    const data = buildDashboardData(sessions, labels, {}, NOW);
    const byName = Object.fromEntries(
      data.avgTokensByModel.allTime.map((s) => [s.name, s.credits])
    );
    assert.strictEqual(byName["Claude Opus 4.8"], 200); // (100 + 300) / 2
  });

  it("averages subagents per session by model, counting zero-subagent sessions", () => {
    const sessions: SessionCost[] = [
      { ...session("s1", 10, ms(2026, 5, 2)), costByModel: { "Claude Opus 4.8": 10 }, subagentCount: 4 },
      { ...session("s2", 10, ms(2026, 5, 2)), costByModel: { "Claude Opus 4.8": 10 }, subagentCount: 0 },
      { ...session("s3", 10, ms(2026, 5, 2)), costByModel: { "Claude Sonnet 5": 10 }, subagentCount: 2 },
    ];
    const data = buildDashboardData(sessions, labels, {}, NOW);
    const byName = Object.fromEntries(
      data.avgSubagentsByModel.allTime.map((s) => [s.name, s.credits])
    );
    assert.strictEqual(byName["Claude Opus 4.8"], 2); // (4 + 0) / 2 — zero counts
    assert.strictEqual(byName["Claude Sonnet 5"], 2);
  });

  it("counts sessions by label including an Unassigned bucket", () => {
    const sessions = [
      session("s1", 10, ms(2026, 5, 2)),
      session("s2", 20, ms(2026, 5, 2)),
      session("s3", 5, ms(2026, 5, 2)),
    ];
    const assignments = { s1: "L1", s2: "L1" }; // s3 unassigned
    const data = buildDashboardData(sessions, labels, assignments, NOW);
    const byName = Object.fromEntries(
      data.sessionsByLabel.allTime.map((s) => [s.name, s.credits])
    );
    assert.strictEqual(byName["Alpha"], 2);
    assert.strictEqual(byName["Unassigned"], 1);
  });
});
