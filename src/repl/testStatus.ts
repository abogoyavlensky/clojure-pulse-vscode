import * as vscode from "vscode";
import { EvalOutcome } from "./connectionManager";
import { testRunFailed } from "./forms";
import {
  shiftRange,
  SimpleChange,
  SimpleRange,
} from "./inlineResults";

// Cursive-style gutter marks for test runs: a green check circle on the
// deftest that passed, a red cross circle on one that failed, the failure
// report on hover. One invariant governs the state: every visible mark
// belongs to the most recent test command. beginRun() wipes the previous
// report and registers an invisible pending mark; report() resolves it by id
// and is a no-op when the id is gone — superseded by a later run, dropped by
// an edit on the deftest, or its document closed — so a stale run can never
// paint a verdict. Marks are deliberately not cleared by Clear Inline
// Results: they leave only via the next test command, an edit, or the
// document closing.

export type TestRunStatus = "pass" | "fail";

/** How a runner outcome reads as a verdict: an eval error or a summary
 *  reporting failures/errors is a fail. */
export function testStatusOf(
  outcome: Pick<EvalOutcome, "err" | "value">,
): TestRunStatus {
  if (outcome.err !== undefined && outcome.err.trim().length > 0) {
    return "fail";
  }
  return testRunFailed(outcome.value) ? "fail" : "pass";
}

/** The hover text for a mark: the failure report (captured out + err) for a
 *  fail, the summary value for a pass. */
export function buildStatusHover(
  status: TestRunStatus,
  outcome: Pick<EvalOutcome, "err" | "value" | "out">,
): string {
  if (status === "pass") {
    return outcome.value ?? "nil";
  }
  const parts = [outcome.out, outcome.err]
    .map((part) => part?.trim() ?? "")
    .filter((part) => part.length > 0);
  if (parts.length === 0) {
    return outcome.value ?? "nil";
  }
  return parts.join("\n\n");
}

interface Mark {
  id: string;
  uri: string;
  /** The whole deftest form: overlap with an edit invalidates the verdict.
   *  The icon renders on the range's first line. */
  range: SimpleRange;
  status: TestRunStatus | "pending";
  hover: string;
}

function toSimpleRange(range: vscode.Range): SimpleRange {
  return {
    start: { line: range.start.line, character: range.start.character },
    end: { line: range.end.line, character: range.end.character },
  };
}

/** Owns the gutter decorations for the last test command's report. */
export class TestStatusManager {
  private readonly passType: vscode.TextEditorDecorationType;
  private readonly failType: vscode.TextEditorDecorationType;
  /** The current run's marks — wiped wholesale by every beginRun. */
  private current: Mark[] = [];
  private nextId = 1;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(icons: { passIcon: vscode.Uri; failIcon: vscode.Uri }) {
    const gutter = (icon: vscode.Uri): vscode.TextEditorDecorationType =>
      vscode.window.createTextEditorDecorationType({
        gutterIconPath: icon,
        gutterIconSize: "contain",
        rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
      });
    this.passType = gutter(icons.passIcon);
    this.failType = gutter(icons.failIcon);

    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((e) => this.onEdit(e)),
      vscode.workspace.onDidCloseTextDocument((doc) => {
        const uri = doc.uri.toString();
        this.current = this.current.filter((mark) => mark.uri !== uri);
        // The editor is gone; nothing to re-render for that document.
      }),
      vscode.window.onDidChangeVisibleTextEditors(() => this.renderAll()),
    );
  }

  /**
   * Starts a new test command: the previous report is superseded, so all
   * marks are wiped, and the deftest about to run gets an invisible pending
   * mark that tracks edits while the run is in flight. Returns its id.
   */
  beginRun(editor: vscode.TextEditor, range: vscode.Range): string {
    this.current = [
      {
        id: `test-${this.nextId++}`,
        uri: editor.document.uri.toString(),
        range: toSimpleRange(range),
        status: "pending",
        hover: "",
      },
    ];
    this.renderAll();
    return this.current[0].id;
  }

  /** Resolves a pending mark into a verdict. A no-op when the id is gone —
   *  superseded, edited away, or its document closed. */
  report(id: string, status: TestRunStatus, hover: string): void {
    const mark = this.current.find((m) => m.id === id);
    if (!mark || mark.status !== "pending") {
      return;
    }
    mark.status = status;
    mark.hover = hover;
    this.renderAll();
  }

  /** The visible verdicts, for tests. Pending marks render nothing. */
  marks(): ReadonlyArray<{
    uri: string;
    line: number;
    status: TestRunStatus;
    hover: string;
  }> {
    return this.current
      .filter((mark) => mark.status !== "pending")
      .map((mark) => ({
        uri: mark.uri,
        line: mark.range.start.line,
        status: mark.status as TestRunStatus,
        hover: mark.hover,
      }));
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.passType.dispose();
    this.failType.dispose();
    this.current = [];
  }

  private onEdit(event: vscode.TextDocumentChangeEvent): void {
    const uri = event.document.uri.toString();
    if (event.contentChanges.length === 0 || !this.current.some((m) => m.uri === uri)) {
      return;
    }
    const survivors: Mark[] = [];
    for (const mark of this.current) {
      if (mark.uri !== uri) {
        survivors.push(mark);
        continue;
      }
      let range: SimpleRange | null = mark.range;
      for (const change of event.contentChanges) {
        const simple: SimpleChange = {
          range: toSimpleRange(change.range),
          text: change.text,
        };
        range = shiftRange(range, simple);
        if (!range) {
          break; // the edit landed on the deftest: the verdict is stale
        }
      }
      if (range) {
        mark.range = range;
        survivors.push(mark);
      }
    }
    this.current = survivors;
    this.renderAll();
  }

  private renderAll(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      const uri = editor.document.uri.toString();
      const buckets: Record<TestRunStatus, vscode.DecorationOptions[]> = {
        pass: [],
        fail: [],
      };
      for (const mark of this.current) {
        if (mark.uri !== uri || mark.status === "pending") {
          continue;
        }
        buckets[mark.status].push(this.toOptions(editor.document, mark));
      }
      editor.setDecorations(this.passType, buckets.pass);
      editor.setDecorations(this.failType, buckets.fail);
    }
  }

  /** The decoration spans the deftest's first line, so the hover with the
   *  report is available on the header text (gutter icons themselves have no
   *  hover in VS Code). */
  private toOptions(doc: vscode.TextDocument, mark: Mark): vscode.DecorationOptions {
    const line = Math.min(mark.range.start.line, doc.lineCount - 1);
    const options: vscode.DecorationOptions = {
      range: doc.lineAt(line).range,
    };
    // Untrusted plain fence: hover text is test output, never command links.
    options.hoverMessage = new vscode.MarkdownString(
      "```clojure\n" + mark.hover + "\n```",
    );
    return options;
  }
}
