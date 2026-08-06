import * as assert from "assert";
import {
  CommandStatusBar,
  commandStatusBarPresentation,
  createCommandStatusBar,
} from "../repl/commandStatusBar";
import { createStatusSlot } from "../repl/statusSlot";
import { createTestStatusBar } from "../repl/testStatusBar";

suite("commandStatusBarPresentation", () => {
  test("running shows a spinner, no colors", () => {
    const view = commandStatusBarPresentation({ phase: "running", name: "reset" });
    assert.strictEqual(view.text, "$(loading~spin) reset");
    assert.strictEqual(view.color, undefined);
    assert.strictEqual(view.backgroundColor, undefined);
  });

  test("success is a green check with the result in the tooltip", () => {
    const view = commandStatusBarPresentation({
      phase: "done",
      name: "reset",
      status: "ok",
      value: ":resumed",
    });
    assert.strictEqual(view.text, "$(check) reset");
    assert.strictEqual(view.color, "testing.iconPassed");
    assert.strictEqual(view.backgroundColor, undefined);
    assert.ok(view.tooltip.includes(":resumed"), view.tooltip);
  });

  test("a multi-line result is truncated to its first line in the tooltip", () => {
    const view = commandStatusBarPresentation({
      phase: "done",
      name: "reset",
      status: "ok",
      value: "{:started true}\n{:details :hidden}",
    });
    assert.ok(view.tooltip.includes("{:started true}"), view.tooltip);
    assert.ok(!view.tooltip.includes(":hidden"), view.tooltip);
  });

  test("a long result is truncated to 100 chars with an ellipsis", () => {
    const value = "x".repeat(250);
    const view = commandStatusBarPresentation({
      phase: "done",
      name: "reset",
      status: "ok",
      value,
    });
    assert.ok(!view.tooltip.includes("x".repeat(101)), "tooltip carries at most 100 chars of the value");
    assert.ok(view.tooltip.includes("x".repeat(100) + "…"), view.tooltip);
  });

  test("success with no value still reads sensibly", () => {
    const view = commandStatusBarPresentation({
      phase: "done",
      name: "reset",
      status: "ok",
    });
    assert.strictEqual(view.text, "$(check) reset");
    assert.ok(/succeeded|output/i.test(view.tooltip), view.tooltip);
  });

  test("failure uses the error background, no color override", () => {
    const view = commandStatusBarPresentation({
      phase: "done",
      name: "reset",
      status: "err",
    });
    assert.strictEqual(view.text, "$(error) reset — failed");
    assert.strictEqual(view.backgroundColor, "statusBarItem.errorBackground");
    assert.strictEqual(view.color, undefined);
  });

  test("click always opens the REPL output", () => {
    for (const view of [
      commandStatusBarPresentation({ phase: "running", name: "t" }),
      commandStatusBarPresentation({ phase: "done", name: "t", status: "ok" }),
      commandStatusBarPresentation({ phase: "done", name: "t", status: "err" }),
    ]) {
      assert.strictEqual(view.command, "clojurePulse.showReplOutput");
    }
  });
});

suite("CommandStatusBar tokens", () => {
  let bar: CommandStatusBar;

  setup(() => {
    bar = createCommandStatusBar();
  });

  teardown(() => {
    bar.dispose();
  });

  test("finish with the current token updates the view", () => {
    const token = bar.running("reset");
    assert.strictEqual(bar.current()?.text, "$(loading~spin) reset");
    bar.finish(token, { phase: "done", name: "reset", status: "ok", value: "nil" });
    assert.strictEqual(bar.current()?.text, "$(check) reset");
  });

  test("a stale token's finish and clear are ignored", () => {
    const stale = bar.running("old");
    const fresh = bar.running("new");
    bar.finish(stale, { phase: "done", name: "old", status: "err" });
    assert.strictEqual(bar.current()?.text, "$(loading~spin) new");
    bar.clear(stale);
    assert.strictEqual(bar.current()?.text, "$(loading~spin) new");
    bar.finish(fresh, { phase: "done", name: "new", status: "ok" });
    assert.strictEqual(bar.current()?.text, "$(check) new");
  });

  test("clear with the current token hides the item", () => {
    const token = bar.running("t");
    bar.clear(token);
    assert.strictEqual(bar.current(), undefined);
  });
});

suite("shared slot across test and command bars", () => {
  test("a command run supersedes a test verdict, and its late finish is a no-op", () => {
    const slot = createStatusSlot({ name: "t", priority: 98 });
    const tests = createTestStatusBar(slot);
    const commands = createCommandStatusBar(slot);
    try {
      const testToken = tests.running("my-test");
      const commandToken = commands.running("reset");
      // The slower test's verdict lands after the command took the slot.
      tests.finish(testToken, {
        phase: "done",
        name: "my-test",
        status: "pass",
        fail: 0,
        error: 0,
      });
      assert.strictEqual(slot.current()?.text, "$(loading~spin) reset");

      commands.finish(commandToken, { phase: "done", name: "reset", status: "ok" });
      assert.strictEqual(slot.current()?.text, "$(check) reset");
      // Both bars read the one slot: the same view through either.
      assert.deepStrictEqual(tests.current(), commands.current());
    } finally {
      slot.dispose();
    }
  });

  test("a test run supersedes a command verdict the same way", () => {
    const slot = createStatusSlot({ name: "t", priority: 98 });
    const tests = createTestStatusBar(slot);
    const commands = createCommandStatusBar(slot);
    try {
      const commandToken = commands.running("reset");
      commands.finish(commandToken, { phase: "done", name: "reset", status: "ok" });
      assert.strictEqual(slot.current()?.text, "$(check) reset");

      const testToken = tests.running("my-test");
      commands.clear(commandToken); // stale: must not hide the test spinner
      assert.strictEqual(slot.current()?.text, "$(loading~spin) my-test");
      tests.finish(testToken, {
        phase: "done",
        name: "my-test",
        status: "pass",
        fail: 0,
        error: 0,
      });
      assert.strictEqual(slot.current()?.text, "$(testing-passed-icon) my-test");
    } finally {
      slot.dispose();
    }
  });
});
