import * as assert from "assert";
import {
  createTestStatusBar,
  testRunCounts,
  testStatusBarPresentation,
  TestStatusBar,
} from "../repl/testStatusBar";

suite("testRunCounts", () => {
  test("summary map counts", () => {
    assert.deepStrictEqual(
      testRunCounts("{:test 1, :pass 0, :fail 1, :error 0, :type :summary}"),
      { fail: 1, error: 0 },
    );
    assert.deepStrictEqual(
      testRunCounts("{:test 3, :pass 0, :fail 2, :error 1}"),
      { fail: 2, error: 1 },
    );
  });

  test("no summary map", () => {
    assert.strictEqual(testRunCounts("nil"), null);
    assert.strictEqual(testRunCounts(undefined), null);
  });
});

suite("testStatusBarPresentation", () => {
  test("running shows a spinner, no colors", () => {
    const view = testStatusBarPresentation({ phase: "running", name: "my-test" });
    assert.strictEqual(view.text, "$(loading~spin) my-test");
    assert.strictEqual(view.color, undefined);
    assert.strictEqual(view.backgroundColor, undefined);
  });

  test("pass is green with the testing icon", () => {
    const view = testStatusBarPresentation({
      phase: "done",
      name: "my-test",
      status: "pass",
      fail: 0,
      error: 0,
    });
    assert.strictEqual(view.text, "$(testing-passed-icon) my-test");
    assert.strictEqual(view.color, "testing.iconPassed");
    assert.strictEqual(view.backgroundColor, undefined);
  });

  test("fail uses the error background and counts, no color override", () => {
    const one = testStatusBarPresentation({
      phase: "done",
      name: "my-test",
      status: "fail",
      fail: 1,
      error: 0,
    });
    assert.strictEqual(one.text, "$(testing-failed-icon) my-test — 1 fail");
    assert.strictEqual(one.backgroundColor, "statusBarItem.errorBackground");
    assert.strictEqual(one.color, undefined);

    assert.strictEqual(
      testStatusBarPresentation({
        phase: "done",
        name: "t",
        status: "fail",
        fail: 0,
        error: 2,
      }).text,
      "$(testing-failed-icon) t — 2 errors",
    );
    assert.strictEqual(
      testStatusBarPresentation({
        phase: "done",
        name: "t",
        status: "fail",
        fail: 1,
        error: 1,
      }).text,
      "$(testing-failed-icon) t — 1 fail, 1 error",
    );
  });

  test("fail with no counts (eval error) says error", () => {
    assert.strictEqual(
      testStatusBarPresentation({
        phase: "done",
        name: "t",
        status: "fail",
        fail: 0,
        error: 0,
      }).text,
      "$(testing-failed-icon) t — error",
    );
  });

  test("click always opens the REPL output", () => {
    for (const view of [
      testStatusBarPresentation({ phase: "running", name: "t" }),
      testStatusBarPresentation({ phase: "done", name: "t", status: "pass", fail: 0, error: 0 }),
    ]) {
      assert.strictEqual(view.command, "clojurePulse.showReplOutput");
    }
  });
});

suite("TestStatusBar tokens", () => {
  let bar: TestStatusBar;

  setup(() => {
    bar = createTestStatusBar();
  });

  teardown(() => {
    bar.dispose();
  });

  test("finish with the current token updates the view", () => {
    const token = bar.running("my-test");
    assert.strictEqual(bar.current()?.text, "$(loading~spin) my-test");
    bar.finish(token, { phase: "done", name: "my-test", status: "pass", fail: 0, error: 0 });
    assert.strictEqual(bar.current()?.text, "$(testing-passed-icon) my-test");
  });

  test("a stale token's finish and clear are ignored", () => {
    const stale = bar.running("old-test");
    const fresh = bar.running("new-test");
    bar.finish(stale, { phase: "done", name: "old-test", status: "fail", fail: 1, error: 0 });
    assert.strictEqual(bar.current()?.text, "$(loading~spin) new-test");
    bar.clear(stale);
    assert.strictEqual(bar.current()?.text, "$(loading~spin) new-test");
    bar.finish(fresh, { phase: "done", name: "new-test", status: "pass", fail: 0, error: 0 });
    assert.strictEqual(bar.current()?.text, "$(testing-passed-icon) new-test");
  });

  test("clear with the current token hides the item", () => {
    const token = bar.running("t");
    bar.clear(token);
    assert.strictEqual(bar.current(), undefined);
  });
});
