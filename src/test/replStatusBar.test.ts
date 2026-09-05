import * as assert from "assert";
import { replStatusPresentation } from "../repl/replStatusBar";

suite("replStatusPresentation", () => {
  test("no configurations at all: offers to add one", () => {
    const view = replStatusPresentation({ busy: false, total: 0 });
    assert.strictEqual(view.text, "$(debug-disconnect) nREPL");
    assert.strictEqual(view.command, "clojurePulse.startRepl");
    assert.ok(/add/i.test(view.tooltip), view.tooltip);
  });

  test("configurations but none running: offers to start one", () => {
    const view = replStatusPresentation({ busy: false, total: 2 });
    assert.strictEqual(view.text, "$(debug-disconnect) nREPL");
    assert.strictEqual(view.command, "clojurePulse.startRepl");
    assert.ok(/start/i.test(view.tooltip), view.tooltip);
  });

  test("a REPL coming up shows a spinner", () => {
    const view = replStatusPresentation({ busy: true, total: 1 });
    assert.strictEqual(view.text, "$(loading~spin) nREPL");
  });

  test("the active session shows its name and address", () => {
    const view = replStatusPresentation({
      active: { name: "dev", info: { host: "localhost", port: 7888 } },
      busy: false,
      total: 2,
    });
    assert.strictEqual(view.text, "$(plug) nREPL dev localhost:7888");
    assert.strictEqual(view.command, "clojurePulse.replMenu");
    assert.ok(view.tooltip.includes("dev"), view.tooltip);
    assert.ok(view.tooltip.includes("localhost:7888"), view.tooltip);
  });

  test("a session named after its address does not repeat it", () => {
    const view = replStatusPresentation({
      active: { name: "127.0.0.1:7890", info: { host: "127.0.0.1", port: 7890 } },
      busy: false,
      total: 1,
    });
    assert.strictEqual(view.text, "$(plug) nREPL 127.0.0.1:7890");
  });

  test("an active session without connection details still renders", () => {
    const view = replStatusPresentation({
      active: { name: "dev" },
      busy: false,
      total: 1,
    });
    assert.strictEqual(view.text, "$(plug) nREPL dev");
    assert.strictEqual(view.command, "clojurePulse.replMenu");
  });
});
