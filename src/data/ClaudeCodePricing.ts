import { ModelRate as MdRate, RateMap } from "./ModelsDevPricing";

/**
 * Token usage of a single assistant turn, split into the fields Anthropic
 * prices independently. Cache-creation is tiered: 5-minute ephemeral cache is
 * billed at 1.25× the input rate, 1-hour cache at 2× the input rate.
 */
export interface PricedUsage {
  input: number;
  output: number;
  /** 5-minute ephemeral cache-creation tokens (1.25× input). */
  cacheWrite5m: number;
  /** 1-hour ephemeral cache-creation tokens (2× input). */
  cacheWrite1h: number;
  cacheRead: number;
}

/**
 * Per-model token prices in US dollars per **million** tokens. Claude Code logs
 * raw token counts but no cost, so we price them from models.dev's `anthropic`
 * catalog to produce a dollar figure per session.
 */
interface ModelRate {
  /** USD per million input tokens. */
  input: number;
  /** USD per million output tokens. */
  output: number;
  /** USD per million 5-minute cache-creation tokens (1.25× input). */
  cacheWrite5m: number;
  /** USD per million 1-hour cache-creation tokens (2× input). */
  cacheWrite1h: number;
  /** USD per million cache-read tokens. */
  cacheRead: number;
}

/**
 * Claude model families, most-specific first, matched against the model id by
 * substring (case-insensitive). New point releases within a family are priced
 * from whichever models.dev `anthropic` entry matches the same family.
 */
const FAMILIES = ["fable", "opus", "sonnet", "haiku"];

/** Family used to price models that match no known family (mid-tier default). */
const DEFAULT_FAMILY = "sonnet";

/**
 * Finds the models.dev `anthropic` rate for a family (e.g. the first
 * `anthropic/…opus…` entry). Returns undefined when pricing is unavailable or
 * the family isn't present in the catalog.
 */
function anthropicRate(family: string, rates: RateMap): MdRate | undefined {
  for (const [key, rate] of rates) {
    if (key.startsWith("anthropic/") && key.includes(family)) {
      return rate;
    }
  }
  return undefined;
}

/**
 * Resolves the per-turn rate for a model id from the models.dev rate map, or
 * undefined for synthetic/no-cost turns or when pricing is unavailable. The
 * 5-minute cache-write rate comes straight from models.dev's `cache_write`
 * (1.25× input); the 1-hour tier is derived as 2× input, which models.dev does
 * not publish separately.
 */
function rateForModel(
  model: string | undefined,
  rates: RateMap
): ModelRate | undefined {
  if (!model) {
    return undefined;
  }
  const lower = model.toLowerCase();
  // Synthetic assistant turns (e.g. "<synthetic>") are not billed.
  if (lower.includes("synthetic")) {
    return undefined;
  }
  const family = FAMILIES.find((f) => lower.includes(f)) ?? DEFAULT_FAMILY;
  const md =
    anthropicRate(family, rates) ?? anthropicRate(DEFAULT_FAMILY, rates);
  if (!md) {
    return undefined;
  }
  return {
    input: md.input,
    output: md.output,
    cacheWrite5m: md.cacheWrite,
    cacheWrite1h: md.input * 2,
    cacheRead: md.cacheRead,
  };
}

/**
 * Computes the US-dollar cost of a single assistant turn's token usage for the
 * given model, using models.dev pricing. Returns 0 for synthetic/untracked
 * turns and when pricing is unavailable (offline / before the first fetch).
 */
export function costForUsage(
  model: string | undefined,
  usage: PricedUsage,
  rates: RateMap
): number {
  const r = rateForModel(model, rates);
  if (!r) {
    return 0;
  }
  return (
    (usage.input * r.input +
      usage.output * r.output +
      usage.cacheWrite5m * r.cacheWrite5m +
      usage.cacheWrite1h * r.cacheWrite1h +
      usage.cacheRead * r.cacheRead) /
    1_000_000
  );
}
