import * as assert from "assert";
import { parseDetails, sumCreditsInLine } from "../../src/data/CostParser";

describe("CostParser.parseDetails", () => {
  it("parses model and credits from a standard details string", () => {
    const entry = parseDetails('"Claude Opus 4.8 • 143.6 credits"');
    assert.deepStrictEqual(entry, { model: "Claude Opus 4.8", credits: 143.6 });
  });

  it("parses integer credit values", () => {
    const entry = parseDetails('"GPT-5.5 • 12 credits"');
    assert.strictEqual(entry?.credits, 12);
  });

  it("returns undefined when there are no credits", () => {
    assert.strictEqual(parseDetails('"Claude Opus 4.8"'), undefined);
  });

  it("returns undefined for non-string input", () => {
    assert.strictEqual(parseDetails(undefined), undefined);
    assert.strictEqual(parseDetails(42), undefined);
    assert.strictEqual(parseDetails(null), undefined);
  });

  it("returns undefined when the model/bullet form is missing", () => {
    // The stricter regex requires the quoted "Model • N credits" form.
    assert.strictEqual(parseDetails('"57.0 credits"'), undefined);
  });
});

describe("CostParser.sumCreditsInLine", () => {
  it("sums a single credit value embedded in a raw line", () => {
    const line = '{"v":{"details":"Claude Opus 4.8 • 47.6 credits"}}';
    assert.strictEqual(sumCreditsInLine(line), 47.6);
  });

  it("sums multiple credit values on one line", () => {
    const line =
      '"GPT-5.5 • 10 credits" ... "Claude • 5.5 credits" ... "GPT • 4 credits"';
    assert.strictEqual(sumCreditsInLine(line), 19.5);
  });

  it("returns 0 when no credits are present", () => {
    assert.strictEqual(sumCreditsInLine('{"v":{"details":"Claude"}}'), 0);
  });

  it("ignores unrelated numbers", () => {
    const line = '{"timestamp":1782271341020,"details":"GPT-5.5 • 12.2 credits"}';
    assert.strictEqual(sumCreditsInLine(line), 12.2);
  });
});
