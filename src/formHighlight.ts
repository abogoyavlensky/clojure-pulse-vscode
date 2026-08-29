import * as vscode from "vscode";
import { bracketPairAtCursor } from "./repl/forms";

/**
 * Highlights the bracket pair of the form "Evaluate Current Form" would send,
 * so the editor shows in advance what a keypress will evaluate. VS Code's own
 * matcher disagrees with eval in common spots — `(foo)|(bar)` (native picks
 * `(bar)`, eval `(foo)`), `(println "hi"|)` (native the parens, eval the
 * string), `(foo | bar)` (native nothing, eval the list) — so the extension
 * turns it off for Clojure via a `[clojure]` `editor.matchBrackets: "never"`
 * default and draws its own, with the native theme colours.
 *
 * One knob: the highlight draws only while the effective Clojure-scoped
 * `editor.matchBrackets` is `"never"`. Set it back to `"always"` in your own
 * `[clojure]` settings and native matching returns, with no double highlight.
 *
 * Atoms and strings get no highlight, and neither does anything below an
 * unclosed bracket (`bracketPairAtCursor` yields null there).
 */

const LANGUAGE_ID = "clojure";

export interface FormHighlighter {
  /** Repaints one editor (clears it when the highlight does not apply). */
  refresh(editor: vscode.TextEditor): void;
  /** Repaints every visible editor. */
  refreshAll(): void;
  dispose(): void;
}

/** True while the extension's own highlight owns bracket matching for `document`. */
function enabled(document: vscode.TextDocument): boolean {
  return (
    vscode.workspace
      .getConfiguration("editor", { languageId: LANGUAGE_ID, uri: document.uri })
      .get<string>("matchBrackets") === "never"
  );
}

/** The two one-character ranges to decorate for every cursor in `editor`. */
function highlightRanges(editor: vscode.TextEditor): vscode.Range[] {
  const document = editor.document;
  const text = document.getText();
  const ranges: vscode.Range[] = [];
  for (const selection of editor.selections) {
    const pair = bracketPairAtCursor(text, document.offsetAt(selection.active));
    if (pair === null) {
      continue;
    }
    for (const offset of [pair.open, pair.close]) {
      const start = document.positionAt(offset);
      ranges.push(new vscode.Range(start, start.translate(0, 1)));
    }
  }
  return ranges;
}

export function createFormHighlighter(): FormHighlighter {
  // The same look as VS Code's `.bracket-match` class: theme background plus a
  // 1px border drawn inside the character box.
  const decorationType = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor("editorBracketMatch.background"),
    borderColor: new vscode.ThemeColor("editorBracketMatch.border"),
    borderStyle: "solid",
    borderWidth: "1px",
    textDecoration: "none; box-sizing: border-box",
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  });

  const refresh = (editor: vscode.TextEditor): void => {
    const applies =
      editor.document.languageId === LANGUAGE_ID && enabled(editor.document);
    editor.setDecorations(decorationType, applies ? highlightRanges(editor) : []);
  };

  return {
    refresh,
    refreshAll(): void {
      for (const editor of vscode.window.visibleTextEditors) {
        refresh(editor);
      }
    },
    dispose(): void {
      decorationType.dispose();
    },
  };
}
