import * as assert from "assert";
import * as vscode from "vscode";
import { createIgnoredFormDecorator, toRanges } from "../ignoredForms";

suite("toRanges", () => {
  test("maps well-formed server ranges to vscode.Range[]", () => {
    const raw = [
      { start: { line: 6, character: 0 }, end: { line: 6, character: 12 } },
      { start: { line: 7, character: 0 }, end: { line: 9, character: 8 } },
    ];
    const ranges = toRanges(raw);
    assert.strictEqual(ranges.length, 2);
    assert.ok(ranges[0].isEqual(new vscode.Range(6, 0, 6, 12)));
    assert.ok(ranges[1].isEqual(new vscode.Range(7, 0, 9, 8)));
  });

  test("returns [] for null / undefined / non-array input", () => {
    assert.deepStrictEqual(toRanges(null), []);
    assert.deepStrictEqual(toRanges(undefined), []);
    assert.deepStrictEqual(toRanges("nope"), []);
  });

  test("skips malformed entries rather than throwing", () => {
    assert.deepStrictEqual(toRanges([{ start: { line: 1 } }]), []);
    assert.deepStrictEqual(toRanges([42, null, {}]), []);
  });
});

suite("createIgnoredFormDecorator", () => {
  test("refresh requests ranges for the editor's document uri", async () => {
    const calls: string[] = [];
    const decorator = createIgnoredFormDecorator((uri) => {
      calls.push(uri);
      return Promise.resolve([]);
    });
    const editor = await openEditor("(comment 1)");
    await decorator.refresh(editor);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0], editor.document.uri.toString());
    decorator.dispose();
  });

  test("refresh swallows a rejected request without throwing", async () => {
    const decorator = createIgnoredFormDecorator(() =>
      Promise.reject(new Error("server down")),
    );
    const editor = await openEditor("#_(x)");
    await decorator.refresh(editor); // must not throw
    decorator.dispose();
  });
});

async function openEditor(content: string): Promise<vscode.TextEditor> {
  const doc = await vscode.workspace.openTextDocument({
    language: "clojure",
    content,
  });
  return vscode.window.showTextDocument(doc);
}
