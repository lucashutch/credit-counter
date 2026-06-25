import { CostEntry } from "./types";

/**
 * Matches credit values in a `details` string, e.g.:
 *   "Claude Opus 4.8 • 143.6 credits"  -> 143.6
 *   "GPT-5.5 • 12.2 credits"           -> 12.2
 * The model portion (before the bullet) is optional.
 */
const CREDITS_RE = /([0-9]+(?:\.[0-9]+)?)\s*credits/gi;

/**
 * Parses a single `details` string into a {@link CostEntry}, or undefined when
 * no credit value is present.
 */
export function parseDetails(details: unknown): CostEntry | undefined {
  if (typeof details !== "string") {
    return undefined;
  }
  CREDITS_RE.lastIndex = 0;
  const match = CREDITS_RE.exec(details);
  if (!match) {
    return undefined;
  }
  const credits = parseFloat(match[1]);
  if (!Number.isFinite(credits)) {
    return undefined;
  }
  // Model name is everything before the bullet/value, trimmed of separators.
  const model = details
    .split(/[•|\-–]/)[0]
    .replace(/credits.*/i, "")
    .trim();
  return { model: model || "Unknown", credits };
}

/**
 * Sums all credit values appearing anywhere in a single raw JSONL line.
 * Using the raw line (rather than a fixed nested path) is resilient to schema
 * changes across VS Code / Copilot versions, where `details` may live at
 * `v.details`, `v.0.result.details`, inside a `requests` array, etc.
 */
export function sumCreditsInLine(rawLine: string): number {
  let total = 0;
  let match: RegExpExecArray | null;
  CREDITS_RE.lastIndex = 0;
  while ((match = CREDITS_RE.exec(rawLine)) !== null) {
    const value = parseFloat(match[1]);
    if (Number.isFinite(value)) {
      total += value;
    }
  }
  return total;
}
