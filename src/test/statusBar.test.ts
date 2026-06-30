import * as assert from "assert";
import { statusPresentation } from "../statusBar";

suite("statusPresentation", () => {
  test("starting shows an animated spinner", () => {
    const view = statusPresentation("starting");
    assert.match(view.text, /clj-pulse/);
    assert.match(view.text, /~spin/);
    assert.strictEqual(view.error, false);
  });

  test("running shows the pulse icon and the version in the tooltip", () => {
    const view = statusPresentation("running", {
      serverInfo: { name: "clj-pulse", version: "0.1.2" },
      command: "/usr/local/bin/clj-pulse",
    });
    assert.match(view.text, /\$\(pulse\) clj-pulse/);
    assert.match(view.tooltip, /0\.1\.2/);
    assert.match(view.tooltip, /clj-pulse/i);
    assert.strictEqual(view.error, false);
  });

  test("running without serverInfo still renders a non-error view", () => {
    const view = statusPresentation("running");
    assert.match(view.text, /clj-pulse/);
    assert.strictEqual(view.error, false);
  });

  test("stopped is a non-error state", () => {
    const view = statusPresentation("stopped");
    assert.match(view.text, /clj-pulse/);
    assert.strictEqual(view.error, false);
  });

  test("error sets the error flag and surfaces the message", () => {
    const view = statusPresentation("error", { message: "clj-pulse not found on PATH" });
    assert.match(view.text, /\$\(error\) clj-pulse/);
    assert.match(view.tooltip, /not found/i);
    assert.strictEqual(view.error, true);
  });
});
