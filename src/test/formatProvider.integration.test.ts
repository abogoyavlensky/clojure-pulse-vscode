import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

const EXTENSION_ID = "abogoyavlensky.clojure-pulse";

const OPTS: vscode.FormattingOptions = { tabSize: 2, insertSpaces: true };

async function openClojureDoc(content: string): Promise<vscode.TextDocument> {
  const doc = await vscode.workspace.openTextDocument({
    language: "clojure",
    content,
  });
  await vscode.window.showTextDocument(doc);
  return doc;
}

async function formatDoc(doc: vscode.TextDocument): Promise<vscode.TextEdit[]> {
  const edits = await vscode.commands.executeCommand<vscode.TextEdit[]>(
    "vscode.executeFormatDocumentProvider",
    doc.uri,
    OPTS,
  );
  return edits ?? [];
}

async function formatRange(
  doc: vscode.TextDocument,
  range: vscode.Range,
): Promise<vscode.TextEdit[]> {
  const edits = await vscode.commands.executeCommand<vscode.TextEdit[]>(
    "vscode.executeFormatRangeProvider",
    doc.uri,
    range,
    OPTS,
  );
  return edits ?? [];
}

async function apply(doc: vscode.TextDocument, edits: vscode.TextEdit[]): Promise<string> {
  const we = new vscode.WorkspaceEdit();
  we.set(doc.uri, edits);
  assert.ok(await vscode.workspace.applyEdit(we));
  return doc.getText();
}

// Expected strings were produced by JVM cljfmt (cljfmt.core/reformat-string,
// cljfmt 0.16.5) on the same inputs.
suite("Format Document / Selection (integration)", () => {
  suiteSetup(async () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext);
    await ext.activate();
  });

  test("cljfmt engine formats the whole document CLI-identically", async () => {
    const doc = await openClojureDoc(
      "(defn messy [x]\n(let [y 1]   \n(println x   y)))\n",
    );
    const text = await apply(doc, await formatDoc(doc));
    // Trailing whitespace removed; non-indenting double spaces kept.
    assert.strictEqual(text, "(defn messy [x]\n  (let [y 1]\n    (println x   y)))\n");
  });

  test("respects a .cljfmt.edn next to the file", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cljp-fmt-"));
    fs.writeFileSync(path.join(dir, ".cljfmt.edn"), "{:sort-ns-references? true}");
    const file = path.join(dir, "app.clj");
    fs.writeFileSync(file, "(ns app (:require [b.core] [a.core]))\n");
    const doc = await vscode.workspace.openTextDocument(file);
    await vscode.window.showTextDocument(doc);
    const text = await apply(doc, await formatDoc(doc));
    assert.strictEqual(text, "(ns app (:require [a.core] [b.core]))\n");
  });

  test("range formatting touches only the intersecting top-level forms", async () => {
    const doc = await openClojureDoc("(a\nb)\n  (c\nd)\n(e\nf)");
    const text = await apply(doc, await formatRange(doc, new vscode.Range(2, 0, 3, 2)));
    // The `(c` form (misindented at top level) is formatted; its siblings
    // `(a b)` and `(e f)` stay exactly as they were.
    assert.strictEqual(text, "(a\nb)\n(c\n d)\n(e\nf)");
  });

  test("a selection spanning two forms formats both, comment included", async () => {
    const doc = await openClojureDoc("(a\nb)\n;; note\n  (c\nd)");
    const text = await apply(doc, await formatRange(doc, new vscode.Range(0, 0, 4, 2)));
    assert.strictEqual(text, "(a\n b)\n;; note\n(c\n d)");
  });

  test("reader prefixes stay part of the range-formatted form", async () => {
    const doc = await openClojureDoc("(x)\n#_(a\nb)\n'(c\nd)");
    const text = await apply(doc, await formatRange(doc, new vscode.Range(1, 0, 4, 2)));
    assert.strictEqual(text, "(x)\n#_(a\n   b)\n'(c\n  d)");
  });

  test("a selection touching no top-level form yields no edits", async () => {
    const doc = await openClojureDoc("(a)\n\n;; only comment\n(b)");
    const edits = await formatRange(doc, new vscode.Range(1, 0, 2, 5));
    assert.deepStrictEqual(edits, []);
  });

  test("an unparseable buffer yields no edits", async () => {
    const doc = await openClojureDoc("(foo");
    assert.deepStrictEqual(await formatDoc(doc), []);
  });

  test("an already-formatted buffer yields no edits", async () => {
    const doc = await openClojureDoc("(a\n b)");
    assert.deepStrictEqual(await formatDoc(doc), []);
  });

  test("structural engine only re-indents", async () => {
    await vscode.workspace
      .getConfiguration("clojurePulse")
      .update("formatting.engine", "structural", vscode.ConfigurationTarget.Global);
    try {
      const doc = await openClojureDoc("(foo   \nbar)");
      const text = await apply(doc, await formatDoc(doc));
      // Indent fixed, trailing whitespace untouched.
      assert.strictEqual(text, "(foo   \n  bar)");
    } finally {
      await vscode.workspace
        .getConfiguration("clojurePulse")
        .update("formatting.engine", undefined, vscode.ConfigurationTarget.Global);
    }
  });
});
