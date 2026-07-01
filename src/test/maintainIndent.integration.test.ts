import * as assert from "assert";
import * as vscode from "vscode";

const EXTENSION_ID = "abogoyavlensky.clojure-pulse";

async function openClojureDoc(content: string): Promise<vscode.TextEditor> {
  const doc = await vscode.workspace.openTextDocument({
    language: "clojure",
    content,
  });
  return vscode.window.showTextDocument(doc);
}

/** Polls until the document text matches `expected` (the shift edit lands
 *  asynchronously after the triggering change event). */
async function waitForText(
  doc: vscode.TextDocument,
  expected: string,
  ms = 3000,
): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (doc.getText() === expected) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.strictEqual(doc.getText(), expected);
}

suite("maintain relative indentation (integration)", () => {
  suiteSetup(async () => {
    // A nonexistent server keeps activation on the resilient no-server path;
    // the indentation listener does not need the language server.
    await vscode.workspace
      .getConfiguration("clojurePulse")
      .update(
        "server.path",
        "clj-pulse-does-not-exist-xyzzy",
        vscode.ConfigurationTarget.Global,
      );
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext, `extension ${EXTENSION_ID} should be present`);
    await ext.activate();
  });

  suiteTeardown(async () => {
    await vscode.workspace
      .getConfiguration("clojurePulse")
      .update("server.path", undefined, vscode.ConfigurationTarget.Global);
  });

  test("typing before a multiline form shifts its body lines", async () => {
    const editor = await openClojureDoc("(foo a\n  b)\n");
    await editor.edit((b) => b.insert(new vscode.Position(0, 0), "  "));
    await waitForText(editor.document, "  (foo a\n    b)\n");
  });

  test("renaming a head symbol keeps argument-aligned lines aligned", async () => {
    const editor = await openClojureDoc("(-> foo\n    bar)\n");
    await editor.edit((b) =>
      b.replace(new vscode.Range(0, 1, 0, 3), "cond->"),
    );
    await waitForText(editor.document, "(cond-> foo\n        bar)\n");
  });

  test("a single undo reverts the keystroke and the shift together", async () => {
    // Drive the edit through the real `type` command: unlike editor.edit()
    // (which closes its own undo group), typing leaves the group open, so
    // the follow-up shift merges into it — exactly the interactive behavior.
    const editor = await openClojureDoc("(foo a\n  b)\n");
    editor.selection = new vscode.Selection(0, 0, 0, 0);
    await vscode.commands.executeCommand("type", { text: " " });
    await waitForText(editor.document, " (foo a\n   b)\n");

    await vscode.commands.executeCommand("undo");
    await waitForText(editor.document, "(foo a\n  b)\n");
  });

  test("the maintainIndentation setting disables the feature", async () => {
    await vscode.workspace
      .getConfiguration("clojurePulse")
      .update("maintainIndentation", false, vscode.ConfigurationTarget.Global);
    try {
      const editor = await openClojureDoc("(foo a\n  b)\n");
      await editor.edit((b) => b.insert(new vscode.Position(0, 0), "  "));
      // Give a (wrong) shift time to land before asserting nothing moved.
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.strictEqual(editor.document.getText(), "  (foo a\n  b)\n");
    } finally {
      await vscode.workspace
        .getConfiguration("clojurePulse")
        .update(
          "maintainIndentation",
          undefined,
          vscode.ConfigurationTarget.Global,
        );
    }
  });

  test("editing inside a multiline string moves nothing", async () => {
    const editor = await openClojureDoc('(def s "a\nb")\n');
    await editor.edit((b) => b.insert(new vscode.Position(0, 8), "  "));
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.strictEqual(editor.document.getText(), '(def s "  a\nb")\n');
  });
});
