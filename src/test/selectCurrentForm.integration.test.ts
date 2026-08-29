import * as assert from "assert";
import * as vscode from "vscode";

const EXTENSION_ID = "abogoyavlensky.clojure-pulse";

/** Splits a source with a single `|` cursor marker into text + offset. */
function at(source: string): { text: string; offset: number } {
  const offset = source.indexOf("|");
  assert.notStrictEqual(offset, -1, "test source must contain a | marker");
  return { text: source.slice(0, offset) + source.slice(offset + 1), offset };
}

/** Opens an in-memory Clojure document with the cursor at the `|` marker. */
async function open(source: string): Promise<vscode.TextEditor> {
  const { text, offset } = at(source);
  const document = await vscode.workspace.openTextDocument({
    language: "clojure",
    content: text,
  });
  const editor = await vscode.window.showTextDocument(document);
  const cursor = document.positionAt(offset);
  editor.selection = new vscode.Selection(cursor, cursor);
  return editor;
}

/** The text the editor's selection covers. */
function selected(editor: vscode.TextEditor): string {
  return editor.document.getText(editor.selection);
}

suite("Select Current Form", () => {
  suiteSetup(async () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext, `extension ${EXTENSION_ID} should be present`);
    await ext.activate();
  });

  teardown(async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  test("is registered", async () => {
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes("clojurePulse.selectCurrentForm"));
  });

  test("selects the form before the cursor, caret after its closer", async () => {
    const editor = await open("(defn f [x] (inc x))|");
    await vscode.commands.executeCommand("clojurePulse.selectCurrentForm");
    assert.strictEqual(selected(editor), "(defn f [x] (inc x))");
    assert.deepStrictEqual(editor.selection.anchor, new vscode.Position(0, 0));
    assert.deepStrictEqual(editor.selection.active, new vscode.Position(0, 20));
  });

  test("selects the enclosing form from whitespace inside it", async () => {
    const editor = await open("(a (b | c) d)");
    await vscode.commands.executeCommand("clojurePulse.selectCurrentForm");
    assert.strictEqual(selected(editor), "(b  c)");
  });

  test("strips a #_ discard marker, as eval does", async () => {
    const editor = await open("#_(a b)|");
    await vscode.commands.executeCommand("clojurePulse.selectCurrentForm");
    assert.strictEqual(selected(editor), "(a b)");
  });

  test("leaves the selection alone when no form resolves", async () => {
    const editor = await open("(unclosed |");
    const before = editor.selection;
    await vscode.commands.executeCommand("clojurePulse.selectCurrentForm");
    assert.ok(editor.selection.isEmpty);
    assert.deepStrictEqual(editor.selection.active, before.active);
  });
});
