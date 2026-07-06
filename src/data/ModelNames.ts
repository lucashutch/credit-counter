/**
 * Normalizes a raw model identifier from any source (Claude Code's
 * `message.model`, OpenCode's `session.model` JSON `id`, or Copilot's
 * `details` display string) into a consistent, human-readable name so the same
 * model coalesces into a single dashboard bucket across harnesses.
 *
 * Examples:
 *   "claude-opus-4-8-20260101" -> "Claude Opus 4.8"
 *   "claude-opus-4.8"          -> "Claude Opus 4.8"
 *   "Claude Opus 4.8"          -> "Claude Opus 4.8"
 *   "gpt-5.5"                  -> "GPT-5.5"
 *   "kimi-k2.7-code"           -> "Kimi K2.7 Code"
 */
export function friendlyModelName(raw: string | undefined): string {
  let s = (raw ?? "").trim();
  if (!s) {
    return "Unknown";
  }
  // Anthropic-style ids can carry a trailing build date: strip it.
  s = s.replace(/[-_]\d{6,8}$/, "");
  const low = s.toLowerCase();

  // The Claude family (opus/sonnet/haiku/fable are all Claude models).
  const family = ["opus", "sonnet", "haiku", "fable"].find((f) =>
    low.includes(f)
  );
  if (family) {
    const ver = low.match(/(\d+(?:[.-]\d+)*)/);
    const version = ver ? ver[1].replace(/-/g, ".") : "";
    const name = family.charAt(0).toUpperCase() + family.slice(1);
    return `Claude ${name}${version ? " " + version : ""}`.trim();
  }

  // OpenAI GPT family.
  if (low.includes("gpt")) {
    const m = low.match(/gpt[-\s]?([\d.]+)/);
    return m ? `GPT-${m[1]}` : "GPT";
  }

  // Otherwise title-case the cleaned id, turning separators into spaces.
  return s
    .replace(/[-_]/g, " ")
    .replace(/\s+/g, " ")
    .split(" ")
    .map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(" ")
    .trim();
}
