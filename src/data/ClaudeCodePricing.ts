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
 * raw token counts but no cost, so we price them here to produce a dollar figure
 * per session.
 *
 * Rates follow Anthropic's published list pricing. Models are matched by family
 * substring (`fable` / `opus` / `sonnet` / `haiku`) so new point releases within
 * a family are priced correctly without a table update.
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

/** Builds a rate from the input/output/cache-read base, deriving cache-write tiers. */
function rate(input: number, output: number, cacheRead: number): ModelRate {
  return {
    input,
    output,
    cacheWrite5m: input * 1.25,
    cacheWrite1h: input * 2,
    cacheRead,
  };
}

/** Family rates, matched against the model id by substring (case-insensitive). */
const FAMILY_RATES: { match: string; rate: ModelRate }[] = [
  { match: "fable", rate: rate(10, 50, 1.0) },
  { match: "opus", rate: rate(5, 25, 0.5) },
  { match: "sonnet", rate: rate(2, 10, 0.2) },
  { match: "haiku", rate: rate(1, 5, 0.1) },
];

/** Fallback rate for unrecognized models (uses Sonnet-tier pricing). */
const DEFAULT_RATE = FAMILY_RATES[2].rate;

/** Resolves the rate table for a model id, or undefined for synthetic/no-cost. */
function rateForModel(model: string | undefined): ModelRate | undefined {
  if (!model) {
    return undefined;
  }
  const lower = model.toLowerCase();
  // Synthetic assistant turns (e.g. "<synthetic>") are not billed.
  if (lower.includes("synthetic")) {
    return undefined;
  }
  const found = FAMILY_RATES.find((f) => lower.includes(f.match));
  return found ? found.rate : DEFAULT_RATE;
}

/**
 * Computes the US-dollar cost of a single assistant turn's token usage for the
 * given model. Returns 0 for synthetic/untracked turns.
 */
export function costForUsage(model: string | undefined, usage: PricedUsage): number {
  const r = rateForModel(model);
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
