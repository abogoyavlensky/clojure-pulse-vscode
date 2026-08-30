import * as assert from "assert";
import * as vscode from "vscode";

const EXTENSION_ID = "abogoyavlensky.clojure-pulse";

/**
 * The form highlight is controlled by one knob: `editor.matchBrackets` in the
 * `[clojure]` scope. The extension's `configurationDefaults` set it to
 * `"never"` there; the highlighter draws only while that is the effective
 * value. These tests pin the assumption that a language-scoped default
 * contributed by an extension is what Clojure documents actually resolve to.
 */
suite("form highlight: editor.matchBrackets in the clojure scope", () => {
  suiteSetup(async () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext, `extension ${EXTENSION_ID} should be present`);
    await ext.activate();
  });

  test("clojure documents resolve to never", () => {
    const value = vscode.workspace
      .getConfiguration("editor", { languageId: "clojure" })
      .get<string>("matchBrackets");
    assert.strictEqual(value, "never");
  });

  test("other languages keep native matching", () => {
    // VS Code's own default (`"always"` at the time of writing) — anything
    // but the `"never"` the extension contributes for Clojure.
    const value = vscode.workspace.getConfiguration("editor").get<string>("matchBrackets");
    assert.notStrictEqual(value, "never");
  });
});
