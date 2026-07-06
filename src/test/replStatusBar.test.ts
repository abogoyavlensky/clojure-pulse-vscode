import * as assert from "assert";
import { replStatusPresentation } from "../repl/replStatusBar";

suite("replStatusPresentation", () => {
  test("disconnected: offers to connect", () => {
    const view = replStatusPresentation("disconnected");
    assert.strictEqual(view.text, "$(debug-disconnect) nREPL");
    assert.strictEqual(view.command, "clojurePulse.connectRepl");
    assert.ok(/connect/i.test(view.tooltip));
  });

  test("connecting: shows a spinner", () => {
    const view = replStatusPresentation("connecting");
    assert.strictEqual(view.text, "$(loading~spin) nREPL");
  });

  test("connected: shows host:port and opens the REPL menu", () => {
    const view = replStatusPresentation("connected", {
      host: "localhost",
      port: 7888,
    });
    assert.strictEqual(view.text, "$(plug) nREPL localhost:7888");
    assert.strictEqual(view.command, "clojurePulse.replMenu");
    assert.ok(view.tooltip.includes("localhost:7888"));
  });

  test("connected without info still renders", () => {
    const view = replStatusPresentation("connected");
    assert.strictEqual(view.text, "$(plug) nREPL");
  });
});
