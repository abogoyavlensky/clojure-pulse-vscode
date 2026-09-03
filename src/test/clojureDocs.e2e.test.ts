/**
 * End to end: the real hover pipeline, the real extension host, and a real
 * clj-pulse binary named by `CLJ_PULSE_E2E_BIN` (skipped when unset, so the
 * regular suite never depends on a server build). Run it with:
 *
 *   CLJ_PULSE_E2E_BIN=/path/to/clj-pulse xvfb-run -a npx vscode-test -g "end to end"
 *
 * What the API lets us observe: `vscode.executeHoverProvider` returns every
 * provider's part, so our markdown is asserted directly; the real command's
 * effect is proven through the request it records being handed to the
 * provider (`clojureDocsRequests.lastTaken`). The focus argument has no
 * observable API and is covered by the VS Code source check in the plan.
 */
import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import type { ExtensionApi } from "../extension";

const BIN = process.env.CLJ_PULSE_E2E_BIN;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function textsOf(hovers: vscode.Hover[] | undefined): string[] {
  return (hovers ?? []).flatMap((hover) =>
    hover.contents.map((content) => (typeof content === "string" ? content : content.value)),
  );
}

suite("ClojureDocs end to end", () => {
  let api: ExtensionApi;

  suiteSetup(async function () {
    if (!BIN) {
      this.skip();
    }
    this.timeout(30000);
    await vscode.workspace
      .getConfiguration("clojurePulse")
      .update("server.path", BIN, vscode.ConfigurationTarget.Global);
    const extension = vscode.extensions.getExtension("abogoyavlensky.clojure-pulse");
    api = (await extension?.activate()) as ExtensionApi;
    // A server-path change is not applied live; restart picks it up.
    await vscode.commands.executeCommand("clojurePulse.restart");
  });

  suiteTeardown(async () => {
    await vscode.commands.executeCommand("editor.action.hideHover");
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await vscode.workspace
      .getConfiguration("clojurePulse")
      .update("server.path", undefined, vscode.ConfigurationTarget.Global);
  });

  test("Show ClojureDocs adds the entry to the hover for the symbol under the cursor", async function () {
    this.timeout(90000);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clojuredocs-e2e-"));
    const file = path.join(dir, "demo.clj");
    fs.writeFileSync(
      file,
      '(ns demo (:require [clojure.string :as str]))\n(map inc [1 2 3])\n(str/join "," [1 2])\n',
    );
    const doc = await vscode.workspace.openTextDocument(file);
    const editor = await vscode.window.showTextDocument(doc);
    const uri = doc.uri.toString();

    // Our part of the hover at a position, after recording the request the
    // command would have recorded.
    const docsPart = async (line: number, character: number) => {
      api.clojureDocsRequests.record({ uri, line, character });
      const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
        "vscode.executeHoverProvider",
        doc.uri,
        new vscode.Position(line, character),
      );
      return textsOf(hovers).find((text) => text.includes("ClojureDocs:"));
    };

    // On `map`. The server may still be starting: keep asking.
    let part: string | undefined;
    const deadline = Date.now() + 60000;
    while (!(part = await docsPart(1, 1)) && Date.now() < deadline) {
      await sleep(1000);
    }
    assert.ok(part, "no ClojureDocs hover part within 60s");
    assert.match(part, /ClojureDocs: clojure\.core\/map/);
    assert.match(part, /\(map inc/);
    assert.match(part, /```clojure/);

    // On the aliased `str/join`: resolved through the ns form.
    const alias = await docsPart(2, 1);
    assert.ok(alias, "no part for str/join");
    assert.match(alias, /ClojureDocs: clojure\.string\/join/);

    // Without a recorded request our provider stays silent: the ordinary
    // hover is unchanged.
    const plain = textsOf(
      await vscode.commands.executeCommand<vscode.Hover[]>(
        "vscode.executeHoverProvider",
        doc.uri,
        new vscode.Position(1, 1),
      ),
    );
    assert.ok(!plain.some((text) => text.includes("ClojureDocs:")), plain.join("\n---\n"));

    // The real command, with the cursor on `inc` (a position no earlier ask
    // used): it must record the request and VS Code's hover pipeline must
    // hand it to our provider.
    editor.selection = new vscode.Selection(1, 5, 1, 5);
    await vscode.commands.executeCommand("clojurePulse.showClojureDocs");
    const until = Date.now() + 10000;
    while (api.clojureDocsRequests.lastTaken?.character !== 5 && Date.now() < until) {
      await sleep(200);
    }
    const taken = api.clojureDocsRequests.lastTaken;
    assert.strictEqual(taken?.uri, uri);
    assert.strictEqual(taken?.line, 1);
    assert.strictEqual(taken?.character, 5);
    assert.strictEqual(taken?.symbol, undefined);
  });
});
