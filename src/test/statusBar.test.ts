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

  test("running gains a lint line naming clj-kondo and its version", () => {
    const view = statusPresentation("running", {
      lint: { engine: "kondo+native", version: "v2026.08.04" },
    });
    assert.match(view.tooltip, /Linting: clj-kondo \+ native \(v2026\.08\.04\)/);
  });

  test("running reports native-only linting when clj-kondo is not in use", () => {
    const view = statusPresentation("running", { lint: { engine: "native" } });
    assert.match(view.tooltip, /Linting: native lints only/);
    assert.doesNotMatch(view.tooltip, /clj-kondo/);
  });

  test("a clj-kondo without a version still renders the engine", () => {
    const view = statusPresentation("running", { lint: { engine: "kondo+native" } });
    assert.match(view.tooltip, /Linting: clj-kondo \+ native$/m);
  });

  test("warming is a tooltip suffix, not a state change", () => {
    const view = statusPresentation("running", {
      lint: { engine: "kondo+native", version: "v2026.08.04", warming: true },
    });
    assert.match(view.tooltip, /warming dependency cache/);
    // The item must keep its normal icon: the spinner means "server
    // unavailable", and a cache scan degrades nothing while it runs.
    assert.match(view.text, /\$\(pulse\) clj-pulse/);
    assert.strictEqual(view.error, false);
  });

  test("without a lint status the tooltip is unchanged", () => {
    // Servers older than the clj-kondo bridge never send the notification.
    const view = statusPresentation("running", {
      serverInfo: { name: "clj-pulse", version: "0.1.2" },
      command: "/usr/local/bin/clj-pulse",
    });
    assert.doesNotMatch(view.tooltip, /Linting:/);
  });

  test("error sets the error flag and surfaces the message", () => {
    const view = statusPresentation("error", { message: "clj-pulse not found on PATH" });
    assert.match(view.text, /\$\(error\) clj-pulse/);
    assert.match(view.tooltip, /not found/i);
    assert.strictEqual(view.error, true);
  });
});
