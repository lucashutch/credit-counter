import * as assert from "assert";
import {
  estimateCost,
  flattenRates,
  ModelRate,
} from "../../src/data/ModelsDevPricing";

const zeroTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

describe("ModelsDevPricing.estimateCost", () => {
  const rate: ModelRate = {
    input: 5,
    output: 30,
    cacheRead: 0.5,
    cacheWrite: 6.25,
  };

  it("prices each token bucket per million tokens", () => {
    // 1M input @ $5 + 1M output @ $30 + 1M cacheRead @ $0.5 + 1M cacheWrite @ $6.25.
    const cost = estimateCost(rate, {
      input: 1_000_000,
      output: 1_000_000,
      cacheRead: 1_000_000,
      cacheWrite: 1_000_000,
    });
    assert.ok(Math.abs(cost - 41.75) < 1e-9);
  });

  it("returns 0 for an unknown (unpriced) model", () => {
    assert.strictEqual(
      estimateCost(undefined, { ...zeroTokens, input: 1_000_000 }),
      0
    );
  });

  it("returns 0 when there is no usage", () => {
    assert.strictEqual(estimateCost(rate, zeroTokens), 0);
  });
});

describe("ModelsDevPricing.flattenRates", () => {
  const api = {
    openai: {
      models: {
        "gpt-5.5": {
          cost: { input: 5, output: 30, cache_read: 0.5, cache_write: 1 },
        },
        "text-embedding-3-large": { cost: { input: 0, output: 0 } },
      },
    },
    google: {
      models: {
        // No cache_write → falls back to the input rate.
        "gemini-3-flash-preview": {
          cost: { input: 0.5, output: 3, cache_read: 0.05 },
        },
      },
    },
    broken: { models: { m: {} }, notModels: 1 },
  };

  it("keys rates by providerID/modelID exactly as OpenCode stores them", () => {
    const rates = flattenRates(api);
    assert.deepStrictEqual(rates.get("openai/gpt-5.5"), {
      input: 5,
      output: 30,
      cacheRead: 0.5,
      cacheWrite: 1,
    });
  });

  it("falls back to the input rate when cache_write is absent", () => {
    const rates = flattenRates(api);
    assert.strictEqual(rates.get("google/gemini-3-flash-preview")?.cacheWrite, 0.5);
  });

  it("skips models with no usable input/output pricing", () => {
    const rates = flattenRates(api);
    assert.strictEqual(rates.has("openai/text-embedding-3-large"), false);
    assert.strictEqual(rates.has("broken/m"), false);
  });

  it("returns an empty map for malformed payloads", () => {
    assert.strictEqual(flattenRates(undefined).size, 0);
    assert.strictEqual(flattenRates("nope").size, 0);
  });
});
