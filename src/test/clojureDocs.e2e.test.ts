/**
 * End to end: the real command, the real extension host, and a real clj-pulse
 * binary named by `CLJ_PULSE_E2E_BIN` (skipped when unset, so the regular
 * suite never depends on a server build). Run it with:
 *
 *   CLJ_PULSE_E2E_BIN=/path/to/clj-pulse xvfb-run -a npx vscode-test -g "end to end"
 */
import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

const BIN = process.env.CLJ_PULSE_E2E_BIN;

function hasTab(label: string): boolean {
  return vscode.window.tabGroups.all.some((group) =>
    group.tabs.some((tab) => tab.label === label),
  );
}

function tabLabels(): string[] {
  return vscode.window.tabGroups.all.flatMap((group) => group.tabs.map((tab) => tab.label));
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

suite("ClojureDocs end to end", () => {
  suiteSetup(async function () {
    if (!BIN) {
      this.skip();
    }
    this.timeout(30000);
    await vscode.workspace
      .getConfiguration("clojurePulse")
      .update("server.path", BIN, vscode.ConfigurationTarget.Global);
    await vscode.extensions.getExtension("abogoyavlensky.clojure-pulse")?.activate();
    // A server-path change is not applied live; restart picks it up.
    await vscode.commands.executeCommand("clojurePulse.restart");
  });

  suiteTeardown(async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await vscode.workspace
      .getConfiguration("clojurePulse")
      .update("server.path", undefined, vscode.ConfigurationTarget.Global);
  });

  test("Show ClojureDocs opens the entry beside the editor and keeps focus", async function () {
    this.timeout(90000);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clojuredocs-e2e-"));
    const file = path.join(dir, "demo.clj");
    fs.writeFileSync(
      file,
      '(ns demo (:require [clojure.string :as str]))\n(map inc [1 2 3])\n(str/join "," [1 2])\n',
    );
    const editor = await vscode.window.showTextDocument(
      await vscode.workspace.openTextDocument(file),
    );

    // On `map`. The server may still be starting: keep asking until the
    // panel appears (each miss only shows an information message).
    editor.selection = new vscode.Selection(1, 1, 1, 1);
    const deadline = Date.now() + 60000;
    while (!hasTab("clojure.core/map") && Date.now() < deadline) {
      await vscode.commands.executeCommand("clojurePulse.showClojureDocs");
      await sleep(1000);
    }
    assert.ok(hasTab("clojure.core/map"), `tabs: ${tabLabels().join(", ")}`);
    assert.strictEqual(
      vscode.window.activeTextEditor?.document.uri.fsPath,
      file,
      "focus must stay in the editor",
    );

    // On the aliased `str/join`: resolved through the ns form, same panel.
    editor.selection = new vscode.Selection(2, 1, 2, 1);
    await vscode.commands.executeCommand("clojurePulse.showClojureDocs");
    const retitled = Date.now() + 15000;
    while (!hasTab("clojure.string/join") && Date.now() < retitled) {
      await sleep(250);
    }
    assert.ok(hasTab("clojure.string/join"), `tabs: ${tabLabels().join(", ")}`);
    assert.ok(!hasTab("clojure.core/map"), "the one panel is retitled, not duplicated");
    assert.strictEqual(vscode.window.activeTextEditor?.document.uri.fsPath, file);
  });
});
