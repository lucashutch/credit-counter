import * as assert from "assert";
import { StateManager } from "../../src/state/StateManager";
import { createFakeContext } from "../mocks/vscode";

// The vscode module is aliased to test/mocks/vscode.ts via test/setup.ts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function newState(): StateManager {
  return new StateManager(createFakeContext() as any);
}

describe("StateManager labels", () => {
  it("adds a label and returns it", async () => {
    const state = newState();
    const label = await state.addLabel("Alpha");
    assert.ok(label);
    assert.strictEqual(label?.name, "Alpha");
    assert.strictEqual(state.getLabels().length, 1);
  });

  it("trims whitespace and rejects empty names", async () => {
    const state = newState();
    assert.strictEqual(await state.addLabel("   "), undefined);
    const label = await state.addLabel("  Beta  ");
    assert.strictEqual(label?.name, "Beta");
  });

  it("rejects duplicate names case-insensitively", async () => {
    const state = newState();
    await state.addLabel("Alpha");
    assert.strictEqual(await state.addLabel("alpha"), undefined);
    assert.strictEqual(state.getLabels().length, 1);
  });

  it("renames a label", async () => {
    const state = newState();
    const label = await state.addLabel("Alpha");
    const ok = await state.renameLabel(label!.id, "Gamma");
    assert.strictEqual(ok, true);
    assert.strictEqual(state.getLabels()[0].name, "Gamma");
  });

  it("does not rename to a duplicate name", async () => {
    const state = newState();
    const a = await state.addLabel("Alpha");
    await state.addLabel("Beta");
    const ok = await state.renameLabel(a!.id, "Beta");
    assert.strictEqual(ok, false);
  });

  it("returns false when renaming a missing label", async () => {
    const state = newState();
    assert.strictEqual(await state.renameLabel("nope", "X"), false);
  });
});

describe("StateManager assignments", () => {
  it("assigns and reads a label for a session", async () => {
    const state = newState();
    const label = await state.addLabel("Alpha");
    await state.assignLabel("session-1", label!.id);
    assert.strictEqual(state.getAssignment("session-1"), label!.id);
  });

  it("clears an assignment when labelId is undefined", async () => {
    const state = newState();
    const label = await state.addLabel("Alpha");
    await state.assignLabel("session-1", label!.id);
    await state.assignLabel("session-1", undefined);
    assert.strictEqual(state.getAssignment("session-1"), undefined);
  });

  it("cascades deletion: removing a label clears its assignments", async () => {
    const state = newState();
    const label = await state.addLabel("Alpha");
    await state.assignLabel("s1", label!.id);
    await state.assignLabel("s2", label!.id);

    await state.deleteLabel(label!.id);

    assert.strictEqual(state.getLabels().length, 0);
    assert.strictEqual(state.getAssignment("s1"), undefined);
    assert.strictEqual(state.getAssignment("s2"), undefined);
  });

  it("leaves other assignments intact when deleting a label", async () => {
    const state = newState();
    const a = await state.addLabel("Alpha");
    const b = await state.addLabel("Beta");
    await state.assignLabel("s1", a!.id);
    await state.assignLabel("s2", b!.id);

    await state.deleteLabel(a!.id);

    assert.strictEqual(state.getAssignment("s1"), undefined);
    assert.strictEqual(state.getAssignment("s2"), b!.id);
  });

  it("fires onDidChange when state mutates", async () => {
    const state = newState();
    let fired = 0;
    state.onDidChange(() => fired++);
    await state.addLabel("Alpha");
    await state.assignLabel("s1", "x");
    assert.ok(fired >= 2);
  });
});
