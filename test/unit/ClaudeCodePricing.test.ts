import * as assert from "assert";
import { costForUsage, PricedUsage } from "../../src/data/ClaudeCodePricing";

const zero: PricedUsage = {
  input: 0,
  output: 0,
  cacheWrite5m: 0,
  cacheWrite1h: 0,
  cacheRead: 0,
};

describe("ClaudeCodePricing.costForUsage", () => {
  it("prices Opus input/output tokens per million", () => {
    // 1M input @ $5 + 1M output @ $25 = $30.
    const cost = costForUsage("claude-opus-4-8", {
      ...zero,
      input: 1_000_000,
      output: 1_000_000,
    });
    assert.strictEqual(cost, 30);
  });

  it("prices Fable input/output tokens per million", () => {
    // 1M input @ $10 + 1M output @ $50 = $60.
    const cost = costForUsage("claude-fable-5", {
      ...zero,
      input: 1_000_000,
      output: 1_000_000,
    });
    assert.strictEqual(cost, 60);
  });

  it("prices 5-minute cache-write at 1.25x input and cache-read separately", () => {
    // Sonnet: 1M 5m-cache @ $2.50 (1.25 × $2) + 1M cache-read @ $0.20 = $2.70.
    const cost = costForUsage("claude-sonnet-5", {
      ...zero,
      cacheWrite5m: 1_000_000,
      cacheRead: 1_000_000,
    });
    assert.ok(Math.abs(cost - 2.7) < 1e-9);
  });

  it("prices 1-hour cache-write at 2x input", () => {
    // Opus: 1M 1h-cache @ $10 (2 × $5) = $10.
    const cost = costForUsage("claude-opus-4-8", {
      ...zero,
      cacheWrite1h: 1_000_000,
    });
    assert.ok(Math.abs(cost - 10) < 1e-9);
  });

  it("matches model families by substring", () => {
    // Haiku: 1M input @ $1 = $1, regardless of the point-release suffix.
    assert.strictEqual(
      costForUsage("claude-haiku-4-5-20251001", { ...zero, input: 1_000_000 }),
      1
    );
  });

  it("does not bill synthetic turns", () => {
    assert.strictEqual(
      costForUsage("<synthetic>", { ...zero, input: 1_000_000 }),
      0
    );
    assert.strictEqual(costForUsage(undefined, { ...zero, input: 1_000_000 }), 0);
  });

  it("falls back to Sonnet-tier pricing for unknown models", () => {
    assert.strictEqual(
      costForUsage("some-future-model", { ...zero, input: 1_000_000 }),
      2
    );
  });
});
