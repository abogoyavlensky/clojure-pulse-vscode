import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import type { ExtensionApi } from "../extension";

const EXTENSION_ID = "abogoyavlensky.clojure-pulse";

function cursor(line: number, character: number): vscode.Selection {
  return new vscode.Selection(line, character, line, character);
}

async function enterIn(file: string): Promise<vscode.TextEditor> {
  const doc = await vscode.workspace.openTextDocument(file);
  const editor = await vscode.window.showTextDocument(doc);
  editor.selections = [cursor(0, 4)];
  await vscode.commands.executeCommand("clojurePulse.newline");
  return editor;
}

suite("cljfmt config status (integration)", () => {
  let api: ExtensionApi;
  let dir: string;
  let configPath: string;

  suiteSetup(async () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext);
    api = (await ext.activate()) as ExtensionApi;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cljp-status-"));
    configPath = path.join(dir, ".cljfmt.edn");
  });

  test("a broken config shows the warning item and formats with defaults", async () => {
    fs.writeFileSync(configPath, "{oops");
    fs.writeFileSync(path.join(dir, "one.clj"), "(foo   bar)");
    const editor = await enterIn(path.join(dir, "one.clj"));
    // Defaults still applied: community one-space indent, no exception.
    assert.strictEqual(editor.document.getText(), "(foo\n bar)");
    const view = api.cljfmtConfigStatus();
    assert.ok(view, "status item should be visible");
    assert.strictEqual(view.text, "$(warning) cljfmt config");
    assert.ok(view.tooltip.includes(configPath), view.tooltip);
  });

  test("fixing the config in the editor hides the item and applies it", async () => {
    fs.writeFileSync(configPath, "{oops");
    fs.writeFileSync(path.join(dir, "two.clj"), "(foo   bar)");
    await enterIn(path.join(dir, "two.clj"));
    assert.ok(api.cljfmtConfigStatus());

    const configDoc = await vscode.workspace.openTextDocument(configPath);
    const editor = await vscode.window.showTextDocument(configDoc);
    await editor.edit((b) =>
      b.replace(
        new vscode.Range(0, 0, configDoc.lineCount, 0),
        "{:function-arguments-indentation :cursive}",
      ),
    );
    await configDoc.save();

    fs.writeFileSync(path.join(dir, "three.clj"), "(foo   bar)");
    const after = await enterIn(path.join(dir, "three.clj"));
    assert.strictEqual(after.document.getText(), "(foo\n  bar)");
    assert.strictEqual(api.cljfmtConfigStatus(), undefined);
  });

  test("the structural engine never shows the item", async () => {
    // Break the config through the editor so the discovery cache notices
    // (a bare fs write outside a workspace folder has no watcher).
    const configDoc = await vscode.workspace.openTextDocument(configPath);
    const editor = await vscode.window.showTextDocument(configDoc);
    await editor.edit((b) =>
      b.replace(new vscode.Range(0, 0, configDoc.lineCount, 0), "{oops"),
    );
    await configDoc.save();
    fs.writeFileSync(path.join(dir, "four.clj"), "(foo   bar)");
    await enterIn(path.join(dir, "four.clj"));
    assert.ok(api.cljfmtConfigStatus());
    await vscode.workspace
      .getConfiguration("clojurePulse")
      .update("formatting.engine", "structural", vscode.ConfigurationTarget.Global);
    try {
      fs.writeFileSync(path.join(dir, "five.clj"), "(foo   bar)");
      await enterIn(path.join(dir, "five.clj"));
      assert.strictEqual(api.cljfmtConfigStatus(), undefined);
    } finally {
      await vscode.workspace
        .getConfiguration("clojurePulse")
        .update("formatting.engine", undefined, vscode.ConfigurationTarget.Global);
    }
  });
});
