import * as assert from "assert";
import * as vscode from "vscode";

const EXTENSION_ID = "abogoyavlensky.clojure-pulse";

/** The def-with-map form from the bug report, as copied. */
const DEF_WITH_MAP = "(def TEST\n  {:a 1\n   :b 2})";

async function openClojureDoc(
  content: string,
  ...selections: vscode.Selection[]
): Promise<vscode.TextEditor> {
  const doc = await vscode.workspace.openTextDocument({
    language: "clojure",
    content,
  });
  const editor = await vscode.window.showTextDocument(doc);
  if (selections.length > 0) {
    editor.selections = selections;
  }
  return editor;
}

/** Polls until the document text matches (the paste provider is async). */
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

function cursor(line: number, character: number): vscode.Selection {
  return new vscode.Selection(line, character, line, character);
}

async function paste(clipboard: string): Promise<void> {
  await vscode.env.clipboard.writeText(clipboard);
  await vscode.commands.executeCommand("editor.action.clipboardPasteAction");
}

suite("indent on paste (integration)", () => {
  suiteSetup(async () => {
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

  test("a pasted def with a map body follows the paste column", async () => {
    const editor = await openClojureDoc("(comment\n  )", cursor(1, 2));
    await paste(DEF_WITH_MAP);
    await waitForText(
      editor.document,
      "(comment\n  (def TEST\n    {:a 1\n     :b 2}))",
    );
    // The caret ends where the pasted form does, as after a plain paste.
    assert.deepStrictEqual(
      [editor.selection.active.line, editor.selection.active.character],
      [3, 11],
    );
  });

  test("a paste past the target column dedents the whole form", async () => {
    const editor = await openClojureDoc("(comment\n      )", cursor(1, 6));
    await paste(DEF_WITH_MAP);
    await waitForText(
      editor.document,
      "(comment\n  (def TEST\n    {:a 1\n     :b 2}))",
    );
  });

  test("a CRLF document keeps its line endings", async () => {
    const editor = await openClojureDoc("(comment\n  )", cursor(1, 2));
    await editor.edit((builder) => builder.setEndOfLine(vscode.EndOfLine.CRLF));
    assert.strictEqual(editor.document.eol, vscode.EndOfLine.CRLF);
    editor.selections = [cursor(1, 2)];
    await paste(DEF_WITH_MAP);
    await waitForText(
      editor.document,
      "(comment\r\n  (def TEST\r\n    {:a 1\r\n     :b 2}))",
    );
  });
});
