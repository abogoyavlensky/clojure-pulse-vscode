import * as vscode from "vscode";
import { EvalOutcome } from "./connectionManager";

// Inline evaluation results: a ghost-text decoration (` => value`) at the end
// of the evaluated form, dimmed while pending, green on success, red on error,
// with the full value on hover and a Copy link. Only stable VS Code API
// (decorations + hover), the pattern Calva and Quokka.js use.
//
// The text-shaping and range-shifting logic is factored into pure helpers
// (no vscode imports) so it can be unit-tested without an editor.

const NBSP = "\u00a0"; // regular spaces collapse in decoration text
const MAX_INLINE = 120;
const NAMESPACE_NOT_LOADED =
  "Namespace not loaded — run 'Evaluate File' first";
const FLASH_MS = 200;

export interface SimplePosition {
  line: number;
  character: number;
}

export interface SimpleRange {
  start: SimplePosition;
  end: SimplePosition;
}

export interface SimpleChange {
  range: SimpleRange;
  text: string;
}

/** The ghost text for a value: first line only, capped, spaces → NBSP. The
 *  gap from the code is a decoration `after.margin`, not a prefix — Cursive
 *  shows the bare value. */
export function formatInlineText(value: string): string {
  const firstLine = value.split("\n")[0];
  const capped =
    firstLine.length > MAX_INLINE
      ? firstLine.slice(0, MAX_INLINE - 1) + "…"
      : firstLine;
  return capped.replace(/ /g, NBSP);
}

/** The decoration range for a result: from the form's start to the end of its
 *  last line, so the `after` ghost text lands at the end of the line — never
 *  between brackets. `endLineLength` is the character length of that last line. */
export function renderRange(
  formRange: SimpleRange,
  endLineLength: number,
): SimpleRange {
  return {
    start: formRange.start,
    end: { line: formRange.end.line, character: endLineLength },
  };
}

/** The hover body: the full value in a clojure fence plus a Copy command link. */
export function buildHoverMarkdown(fullText: string, resultId: string): string {
  const args = encodeURIComponent(JSON.stringify([resultId]));
  return (
    "```clojure\n" +
    fullText +
    "\n```\n\n" +
    `[Copy result](command:clojurePulse.copyEvalResult?${args})`
  );
}

function posLE(a: SimplePosition, b: SimplePosition): boolean {
  return a.line < b.line || (a.line === b.line && a.character <= b.character);
}

/** Shifts one position that lies at or after a change's end. */
function shiftPosition(
  p: SimplePosition,
  change: SimpleChange,
): SimplePosition {
  const cStart = change.range.start;
  const cEnd = change.range.end;
  const newlines = (change.text.match(/\n/g) ?? []).length;
  const lineDelta = cStart.line + newlines - cEnd.line;
  if (p.line !== cEnd.line) {
    return { line: p.line + lineDelta, character: p.character };
  }
  // p sits on the change's last replaced line: its column is measured from the
  // end of the inserted text.
  const lastLineLen =
    newlines === 0
      ? cStart.character + change.text.length
      : change.text.length - change.text.lastIndexOf("\n") - 1;
  return {
    line: p.line + lineDelta,
    character: lastLineLen + (p.character - cEnd.character),
  };
}

/**
 * The range after a document change, or null when the change intersects it (so
 * the result should be dropped). Changes entirely at/before the start shift the
 * range; changes at/after the end leave it untouched.
 */
export function shiftRange(
  range: SimpleRange,
  change: SimpleChange,
): SimpleRange | null {
  if (posLE(change.range.end, range.start)) {
    return {
      start: shiftPosition(range.start, change),
      end: shiftPosition(range.end, change),
    };
  }
  if (posLE(range.end, change.range.start)) {
    return range;
  }
  return null; // overlap
}

type ResultState = "pending" | "success" | "error";

interface InlineResult {
  id: string;
  range: SimpleRange;
  state: ResultState;
  /** Raw value or error message; shown on hover and copied. */
  fullText: string;
}

function toSimpleRange(range: vscode.Range): SimpleRange {
  return {
    start: { line: range.start.line, character: range.start.character },
    end: { line: range.end.line, character: range.end.character },
  };
}

function toVscodeRange(range: SimpleRange): vscode.Range {
  return new vscode.Range(
    range.start.line,
    range.start.character,
    range.end.line,
    range.end.character,
  );
}

/**
 * Owns the inline-result decorations and their per-document state. Callers
 * mark a range pending when they send an eval and resolve it with the outcome;
 * the manager keeps results glued to their forms across edits and drops them
 * when an edit lands on top.
 */
export class InlineResultsManager {
  private readonly pendingType: vscode.TextEditorDecorationType;
  private readonly successType: vscode.TextEditorDecorationType;
  private readonly errorType: vscode.TextEditorDecorationType;
  private readonly flashType: vscode.TextEditorDecorationType;

  /** results per document uri, oldest first. */
  private readonly byDoc = new Map<string, InlineResult[]>();
  private readonly byId = new Map<string, InlineResult>();
  private nextId = 1;
  private latestId: string | undefined;
  private flashTimer: ReturnType<typeof setTimeout> | undefined;
  private flashEditor: vscode.TextEditor | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor() {
    const after = (color: string): vscode.DecorationRenderOptions => ({
      after: {
        color: new vscode.ThemeColor(color),
        // A gap from the code — the result reads as a trailing hint, not a token.
        margin: "0 0 0 2ch",
        fontStyle: "italic",
      },
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
    });
    // Cursive-style muted grey for pending/success; red for errors.
    this.pendingType = vscode.window.createTextEditorDecorationType(
      after("editorInlayHint.foreground"),
    );
    this.successType = vscode.window.createTextEditorDecorationType(
      after("editorInlayHint.foreground"),
    );
    this.errorType = vscode.window.createTextEditorDecorationType(
      after("errorForeground"),
    );
    this.flashType = vscode.window.createTextEditorDecorationType({
      backgroundColor: new vscode.ThemeColor("editor.wordHighlightBackground"),
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
    });

    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((e) => this.onEdit(e)),
      vscode.workspace.onDidCloseTextDocument((doc) =>
        this.forget(doc.uri.toString()),
      ),
      vscode.window.onDidChangeVisibleTextEditors(() => this.renderAll()),
    );
  }

  /** Drops all state for a document (e.g. when it closes), so a late-resolving
   *  eval and copy/latest lookups never touch stale results. */
  private forget(uri: string): void {
    for (const result of this.byDoc.get(uri) ?? []) {
      this.byId.delete(result.id);
      if (this.latestId === result.id) {
        this.latestId = undefined;
      }
    }
    this.byDoc.delete(uri);
    this.updateContext();
  }

  /** Marks the evaluated range pending and flashes it. Returns the result id. */
  markPending(editor: vscode.TextEditor, range: vscode.Range): string {
    const uri = editor.document.uri.toString();
    const simple = toSimpleRange(range);
    const list = this.byDoc.get(uri) ?? [];
    // One result per line: drop any earlier result ending on the same line.
    for (const stale of list.filter((r) => r.range.end.line === simple.end.line)) {
      this.byId.delete(stale.id);
    }
    const kept = list.filter((r) => r.range.end.line !== simple.end.line);
    const result: InlineResult = {
      id: `eval-${this.nextId++}`,
      range: simple,
      state: "pending",
      fullText: "",
    };
    kept.push(result);
    this.byDoc.set(uri, kept);
    this.byId.set(result.id, result);
    this.latestId = result.id;

    this.flash(editor, range);
    this.render(editor.document);
    this.updateContext();
    return result.id;
  }

  /** Resolves a pending result with its outcome; a no-op when the id is gone
   *  (the result was cleared, dropped by an edit, or the doc closed). */
  resolve(id: string, outcome: EvalOutcome): void {
    const result = this.byId.get(id);
    if (!result) {
      return;
    }
    if (outcome.namespaceNotFound) {
      result.state = "error";
      result.fullText = NAMESPACE_NOT_LOADED;
    } else if (outcome.err && outcome.err.trim().length > 0) {
      result.state = "error";
      result.fullText = outcome.err.replace(/\s+$/, "");
    } else {
      result.state = "success";
      result.fullText = outcome.value ?? "nil";
    }
    this.renderDoc(result);
  }

  /** Marks a pending result as a failure (e.g. the socket dropped mid-eval). */
  fail(id: string, message: string): void {
    const result = this.byId.get(id);
    if (!result) {
      return;
    }
    result.state = "error";
    result.fullText = message;
    this.renderDoc(result);
  }

  fullTextOf(id: string): string | undefined {
    return this.byId.get(id)?.fullText;
  }

  /** The most recent result whose range covers `line` in `uri`, if any. */
  resultAt(uri: string, line: number): string | undefined {
    const list = this.byDoc.get(uri);
    if (!list) {
      return undefined;
    }
    for (let i = list.length - 1; i >= 0; i--) {
      const r = list[i];
      if (line >= r.range.start.line && line <= r.range.end.line) {
        return r.fullText;
      }
    }
    return undefined;
  }

  /** The full text of the most recently created result, if any. */
  latest(): string | undefined {
    return this.latestId ? this.byId.get(this.latestId)?.fullText : undefined;
  }

  /** Whether any inline results are currently shown. */
  hasResults(): boolean {
    return this.byId.size > 0;
  }

  clearAll(): void {
    this.byDoc.clear();
    this.byId.clear();
    this.latestId = undefined;
    this.renderAll();
    this.updateContext();
  }

  /** Publishes `clojurePulse.hasInlineResults` so the Escape keybinding only
   *  intercepts Escape while results are on screen. */
  private updateContext(): void {
    void vscode.commands.executeCommand(
      "setContext",
      "clojurePulse.hasInlineResults",
      this.byId.size > 0,
    );
  }

  dispose(): void {
    if (this.flashTimer) {
      clearTimeout(this.flashTimer);
    }
    for (const d of this.disposables) {
      d.dispose();
    }
    this.pendingType.dispose();
    this.successType.dispose();
    this.errorType.dispose();
    this.flashType.dispose();
    this.byDoc.clear();
    this.byId.clear();
    this.updateContext(); // reset the context key so Escape isn't left bound
  }

  private onEdit(event: vscode.TextDocumentChangeEvent): void {
    const uri = event.document.uri.toString();
    const list = this.byDoc.get(uri);
    if (!list || list.length === 0 || event.contentChanges.length === 0) {
      return;
    }
    // VS Code delivers changes highest-position-first; applying them in that
    // order keeps each change's original coordinates valid for the ranges it
    // still needs to move.
    const survivors: InlineResult[] = [];
    for (const result of list) {
      let range: SimpleRange | null = result.range;
      for (const change of event.contentChanges) {
        range = shiftRange(range, {
          range: toSimpleRange(change.range),
          text: change.text,
        });
        if (!range) {
          break;
        }
      }
      if (range) {
        result.range = range;
        survivors.push(result);
      } else {
        this.byId.delete(result.id);
      }
    }
    this.byDoc.set(uri, survivors);
    this.render(event.document);
    this.updateContext();
  }

  private flash(editor: vscode.TextEditor, range: vscode.Range): void {
    if (this.flashTimer) {
      clearTimeout(this.flashTimer);
      // Clear the earlier flash — it may be in a different editor that the
      // replaced timer would otherwise have left highlighted.
      this.flashEditor?.setDecorations(this.flashType, []);
    }
    editor.setDecorations(this.flashType, [range]);
    this.flashEditor = editor;
    this.flashTimer = setTimeout(() => {
      editor.setDecorations(this.flashType, []);
      this.flashTimer = undefined;
      this.flashEditor = undefined;
    }, FLASH_MS);
  }

  private renderDoc(result: InlineResult): void {
    for (const [uri, list] of this.byDoc) {
      if (list.includes(result)) {
        const doc = vscode.workspace.textDocuments.find(
          (d) => d.uri.toString() === uri,
        );
        if (doc) {
          this.render(doc);
        }
        return;
      }
    }
  }

  private renderAll(): void {
    const docs = new Set<vscode.TextDocument>();
    for (const editor of vscode.window.visibleTextEditors) {
      docs.add(editor.document);
    }
    for (const doc of docs) {
      this.render(doc);
    }
  }

  private render(doc: vscode.TextDocument): void {
    const editors = vscode.window.visibleTextEditors.filter(
      (e) => e.document === doc,
    );
    if (editors.length === 0) {
      return;
    }
    const list = this.byDoc.get(doc.uri.toString()) ?? [];
    const buckets: Record<ResultState, vscode.DecorationOptions[]> = {
      pending: [],
      success: [],
      error: [],
    };
    for (const result of list) {
      buckets[result.state].push(this.toOptions(doc, result));
    }
    for (const editor of editors) {
      editor.setDecorations(this.pendingType, buckets.pending);
      editor.setDecorations(this.successType, buckets.success);
      editor.setDecorations(this.errorType, buckets.error);
    }
  }

  private toOptions(
    doc: vscode.TextDocument,
    result: InlineResult,
  ): vscode.DecorationOptions {
    const contentText =
      result.state === "pending" ? "…" : formatInlineText(result.fullText);
    // Anchor the ghost text to the end of the form's last line — never between
    // brackets. Clamp the line in case a stored range briefly outruns the doc
    // mid-edit.
    const endLine = Math.min(result.range.end.line, doc.lineCount - 1);
    const endLineLength = doc.lineAt(endLine).range.end.character;
    const options: vscode.DecorationOptions = {
      range: toVscodeRange(
        renderRange({ ...result.range, end: { ...result.range.end, line: endLine } }, endLineLength),
      ),
      renderOptions: { after: { contentText } },
    };
    if (result.state !== "pending") {
      const md = new vscode.MarkdownString(
        buildHoverMarkdown(result.fullText, result.id),
      );
      // Trust only our Copy command — result text is untrusted and could
      // otherwise smuggle an active `command:` link into the hover.
      md.isTrusted = { enabledCommands: ["clojurePulse.copyEvalResult"] };
      options.hoverMessage = md;
    }
    return options;
  }
}
