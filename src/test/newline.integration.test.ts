import * as assert from "assert";
import * as vscode from "vscode";

const EXTENSION_ID = "abogoyavlensky.clojure-pulse";

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

/** Polls until the document text matches (follow-up shifts land async). */
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

suite("clojurePulse.newline (integration)", () => {
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

  test("aligns the new line under the vector's first element", async () => {
    const editor = await openClojureDoc("(let [a 1])", cursor(0, 9));
    await vscode.commands.executeCommand("clojurePulse.newline");
    assert.strictEqual(editor.document.getText(), "(let [a 1\n      ])");
    assert.deepStrictEqual(
      [editor.selection.active.line, editor.selection.active.character],
      [1, 6],
    );
  });

  test("2-space indent inside a symbol-headed list", async () => {
    const editor = await openClojureDoc("(when x y)", cursor(0, 7));
    await vscode.commands.executeCommand("clojurePulse.newline");
    assert.strictEqual(editor.document.getText(), "(when x\n  y)");
    assert.deepStrictEqual(
      [editor.selection.active.line, editor.selection.active.character],
      [1, 2],
    );
  });

  test("plain newline inside a string", async () => {
    const editor = await openClojureDoc('(def s "ab")', cursor(0, 9));
    await vscode.commands.executeCommand("clojurePulse.newline");
    assert.strictEqual(editor.document.getText(), '(def s "a\nb")');
    assert.deepStrictEqual(
      [editor.selection.active.line, editor.selection.active.character],
      [1, 0],
    );
  });

  test("eats whitespace after the cursor instead of stranding it", async () => {
    const editor = await openClojureDoc("(foo   bar)", cursor(0, 4));
    await vscode.commands.executeCommand("clojurePulse.newline");
    assert.strictEqual(editor.document.getText(), "(foo\n  bar)");
    assert.deepStrictEqual(
      [editor.selection.active.line, editor.selection.active.character],
      [1, 2],
    );
  });

  test("multi-cursor: each selection gets its own indent", async () => {
    // Cursors sit before the space preceding `b` / `y`, so the space is
    // eaten rather than stranded as a trailing space.
    const editor = await openClojureDoc(
      "(when a b)\n(let [x 1 y])",
      cursor(0, 7),
      cursor(1, 9),
    );
    await vscode.commands.executeCommand("clojurePulse.newline");
    assert.strictEqual(
      editor.document.getText(),
      "(when a\n  b)\n(let [x 1\n      y])",
    );
    const points = editor.selections.map((s) => [s.active.line, s.active.character]);
    assert.deepStrictEqual(points, [
      [1, 2],
      [3, 6],
    ]);
  });

  test("Enter before a multiline form carries its body along", async () => {
    // The composed behavior: the newline moves `(b` to a new column and the
    // form's body shifts to match, folded into the same atomic edit.
    const editor = await openClojureDoc("(a (b\n    c))", cursor(0, 2));
    await vscode.commands.executeCommand("clojurePulse.newline");
    await waitForText(editor.document, "(a\n  (b\n   c))");
    assert.deepStrictEqual(
      [editor.selection.active.line, editor.selection.active.character],
      [1, 2],
    );
  });

  test("one undo reverts the Enter and the carried body together", async () => {
    const editor = await openClojureDoc("(a (b\n    c))", cursor(0, 2));
    await vscode.commands.executeCommand("clojurePulse.newline");
    await waitForText(editor.document, "(a\n  (b\n   c))");

    await vscode.commands.executeCommand("undo");
    await waitForText(editor.document, "(a (b\n    c))");
  });
});
