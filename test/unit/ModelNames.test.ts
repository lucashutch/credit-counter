import * as assert from "assert";
import { friendlyModelName } from "../../src/data/ModelNames";

describe("friendlyModelName", () => {
  it("normalizes Claude Code model ids, stripping the build date", () => {
    assert.strictEqual(friendlyModelName("claude-opus-4-8-20260101"), "Claude Opus 4.8");
    assert.strictEqual(friendlyModelName("claude-sonnet-5-20251001"), "Claude Sonnet 5");
    assert.strictEqual(friendlyModelName("claude-haiku-4-5"), "Claude Haiku 4.5");
  });

  it("coalesces OpenCode ids and Copilot display strings to the same name", () => {
    assert.strictEqual(friendlyModelName("claude-opus-4.8"), "Claude Opus 4.8");
    assert.strictEqual(friendlyModelName("Claude Opus 4.8"), "Claude Opus 4.8");
  });

  it("recognizes the GPT family", () => {
    assert.strictEqual(friendlyModelName("gpt-5.5"), "GPT-5.5");
    assert.strictEqual(friendlyModelName("GPT-5.5"), "GPT-5.5");
  });

  it("title-cases unknown model ids", () => {
    assert.strictEqual(friendlyModelName("kimi-k2.7-code"), "Kimi K2.7 Code");
    assert.strictEqual(friendlyModelName("glm-5.1"), "Glm 5.1");
  });

  it("falls back to Unknown for empty input", () => {
    assert.strictEqual(friendlyModelName(undefined), "Unknown");
    assert.strictEqual(friendlyModelName("  "), "Unknown");
  });
});
