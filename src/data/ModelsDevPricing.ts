import * as vscode from "vscode";

/**
 * Per-model token prices in US dollars per **million** tokens, as published by
 * models.dev. OpenCode records raw token usage plus the `providerID`/`modelID`
 * for every assistant turn, but reports `$0` for subscription/plan providers
 * (e.g. a ChatGPT/Codex or Copilot subscription). We price those turns here so
 * their cost can be *estimated* rather than dropped.
 */
export interface ModelRate {
  /** USD per million input tokens. */
  input: number;
  /** USD per million output tokens (reasoning tokens are billed as output). */
  output: number;
  /** USD per million cache-read tokens. */
  cacheRead: number;
  /** USD per million cache-write tokens. */
  cacheWrite: number;
}

/** Token buckets to price, matching OpenCode's per-message `tokens` shape. */
export interface EstimateTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** Rates keyed by `"${providerID}/${modelID}"`, exactly as OpenCode stores them. */
export type RateMap = Map<string, ModelRate>;

/** Result of {@link ModelsDevPricing.getRates}: the rates plus a freshness stamp. */
export interface RatesResult {
  rates: RateMap;
  /** `fetchedAt` epoch-ms of the data backing `rates`; 0 when no data is available. */
  stamp: number;
}

/** `globalState` key under which the fetched models.dev pricing is persisted. */
const CACHE_KEY = "creditCounter.modelsDevPricing";

/** models.dev combined catalog endpoint. */
const API_URL = "https://models.dev/api.json";

/** Re-fetch rates once the cached copy is older than this (24 hours). */
const TTL_MS = 24 * 60 * 60 * 1000;

/** Persisted pricing cache. `rates` is a plain record for JSON storage. */
interface PricingCache {
  fetchedAt: number;
  rates: Record<string, ModelRate>;
}

/**
 * Computes the estimated USD cost of a set of token buckets under `rate`.
 * Returns 0 when the model has no known rate (e.g. local `lmstudio` models),
 * so unpriced usage stays free rather than being fabricated.
 */
export function estimateCost(
  rate: ModelRate | undefined,
  tokens: EstimateTokens
): number {
  if (!rate) {
    return 0;
  }
  return (
    (tokens.input * rate.input +
      tokens.output * rate.output +
      tokens.cacheRead * rate.cacheRead +
      tokens.cacheWrite * rate.cacheWrite) /
    1_000_000
  );
}

/**
 * Flattens a models.dev `api.json` payload into a {@link RateMap}. The payload
 * is keyed by provider id, each with a `models` map whose entries carry a
 * `cost` object (`input`, `output`, `cache_read`, `cache_write`, per million
 * tokens). Entries without usable numeric costs are skipped. Missing
 * `cache_write` falls back to the input rate (typical provider behaviour).
 */
export function flattenRates(apiJson: unknown): RateMap {
  const rates: RateMap = new Map();
  if (!apiJson || typeof apiJson !== "object") {
    return rates;
  }
  for (const [providerId, provider] of Object.entries(
    apiJson as Record<string, unknown>
  )) {
    const models = (provider as { models?: unknown })?.models;
    if (!models || typeof models !== "object") {
      continue;
    }
    for (const [modelId, model] of Object.entries(
      models as Record<string, unknown>
    )) {
      const cost = (model as { cost?: unknown })?.cost as
        | Record<string, unknown>
        | undefined;
      if (!cost || typeof cost !== "object") {
        continue;
      }
      const input = num(cost.input);
      const output = num(cost.output);
      const cacheRead = num(cost.cache_read);
      // Some models omit cache_write; providers typically bill it near input.
      const cacheWrite =
        cost.cache_write !== undefined ? num(cost.cache_write) : input;
      if (input === 0 && output === 0) {
        continue; // no usable pricing
      }
      rates.set(`${providerId}/${modelId}`, {
        input,
        output,
        cacheRead,
        cacheWrite,
      });
    }
  }
  return rates;
}

function num(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/**
 * Fetches and caches models.dev pricing so OpenCode subscription sessions
 * (which report `$0`) can have their cost estimated from token usage.
 *
 * The catalog is fetched over the network and persisted to `globalState` with a
 * 24-hour TTL. There is no bundled fallback: if the fetch fails and nothing has
 * ever been cached, {@link getRates} returns an empty map and estimation is
 * simply skipped for that run. A previously-fetched (even stale) copy is reused
 * when a refresh fails.
 */
export class ModelsDevPricing {
  private inFlight: Promise<RatesResult> | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {}

  /** Returns current rates, fetching/refreshing as needed. Calls are coalesced. */
  getRates(): Promise<RatesResult> {
    if (!this.inFlight) {
      this.inFlight = this.resolve().finally(() => {
        this.inFlight = undefined;
      });
    }
    return this.inFlight;
  }

  private async resolve(): Promise<RatesResult> {
    const cached = this.context.globalState.get<PricingCache>(CACHE_KEY);
    const fresh =
      cached && Date.now() - cached.fetchedAt < TTL_MS && cached.rates;
    if (fresh) {
      return { rates: toMap(cached.rates), stamp: cached.fetchedAt };
    }

    try {
      const rates = await this.fetchRates();
      if (rates.size > 0) {
        const fetchedAt = Date.now();
        await this.context.globalState.update(CACHE_KEY, {
          fetchedAt,
          rates: toRecord(rates),
        } satisfies PricingCache);
        return { rates, stamp: fetchedAt };
      }
    } catch {
      // Network/parse failure — fall through to any stale cache below.
    }

    if (cached?.rates) {
      return { rates: toMap(cached.rates), stamp: cached.fetchedAt };
    }
    return { rates: new Map(), stamp: 0 };
  }

  private async fetchRates(): Promise<RateMap> {
    const res = await fetch(API_URL);
    if (!res.ok) {
      throw new Error(`models.dev responded ${res.status}`);
    }
    return flattenRates(await res.json());
  }
}

function toRecord(rates: RateMap): Record<string, ModelRate> {
  const out: Record<string, ModelRate> = {};
  for (const [k, v] of rates) {
    out[k] = v;
  }
  return out;
}

function toMap(record: Record<string, ModelRate>): RateMap {
  return new Map(Object.entries(record));
}
