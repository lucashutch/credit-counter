import { CostEntry } from "./types";
import { friendlyModelName } from "./ModelNames";

/**
 * Matches credit values inside a quoted `details` string, e.g.:
 *   "Claude Opus 4.8 • 143.6 credits"  -> model "Claude Opus 4.8", 143.6
 *   "GPT-5.5 • 12.2 credits"           -> model "GPT-5.5", 12.2
 * Capture group 1 is the model, group 2 is the numeric credit value.
 * Group 1 excludes quotes so it cannot span across JSON string boundaries
 * when scanning a whole raw line.
 */
const CREDITS_RE = /"([^"]+?)\s*•\s*(\d+(?:\.\d+)?)\s*credits"/gi;

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
  const credits = parseFloat(match[2]);
  if (!Number.isFinite(credits)) {
    return undefined;
  }
  // Model name is capture group 1; treat a purely numeric value as no model.
  let model = match[1].trim();
  if (/^[0-9.]+$/.test(model)) {
    model = "";
  }
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
    const value = parseFloat(match[2]);
    if (Number.isFinite(value)) {
      total += value;
    }
  }
  return total;
}

/**
 * Accumulates credit values in a single raw JSONL line into `out`, keyed by
 * (normalized) model name. Mirrors {@link sumCreditsInLine} but preserves the
 * per-model attribution captured in each `details` string.
 */
export function addCreditsByModelInLine(
  rawLine: string,
  out: Record<string, number>
): void {
  let match: RegExpExecArray | null;
  CREDITS_RE.lastIndex = 0;
  while ((match = CREDITS_RE.exec(rawLine)) !== null) {
    const value = parseFloat(match[2]);
    if (!Number.isFinite(value)) {
      continue;
    }
    const rawModel = /^[0-9.]+$/.test(match[1].trim()) ? "" : match[1].trim();
    const model = friendlyModelName(rawModel || "Unknown");
    out[model] = (out[model] ?? 0) + value;
  }
}
