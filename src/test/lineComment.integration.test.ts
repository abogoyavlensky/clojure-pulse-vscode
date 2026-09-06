import * as assert from "assert";
import * as vscode from "vscode";

const EXTENSION_ID = "abogoyavlensky.clojure-pulse";

/** Lets the extension's configuration listener land before the command runs. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 100));
}

/** Comments the first line of a fresh Clojure document under `setting`. */
async function commentedFirstLine(setting: string | undefined): Promise<string> {
  await vscode.workspace
    .getConfiguration("clojurePulse")
    .update("lineComment", setting, vscode.ConfigurationTarget.Global);
  await settle();
  const document = await vscode.workspace.openTextDocument({
    language: "clojure",
    content: "(foo)\n",
  });
  const editor = await vscode.window.showTextDocument(document);
  editor.selection = new vscode.Selection(0, 0, 0, 0);
  await vscode.commands.executeCommand("editor.action.commentLine");
  return document.lineAt(0).text;
}

suite("line comment setting", () => {
  suiteSetup(async () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext, `extension ${EXTENSION_ID} should be present`);
    await ext.activate();
  });

  teardown(async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  test('";;" makes Toggle Line Comment insert ;;', async () => {
    try {
      assert.strictEqual(await commentedFirstLine(";;"), ";; (foo)");
    } finally {
      await vscode.workspace
        .getConfiguration("clojurePulse")
        .update("lineComment", undefined, vscode.ConfigurationTarget.Global);
    }
  });

  test("the default inserts a single ;", async () => {
    assert.strictEqual(await commentedFirstLine(undefined), "; (foo)");
  });
});
