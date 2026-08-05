import * as vscode from "vscode";

// The last custom REPL command's verdict in the status bar: a spinner while
// the eval is in flight, then a green check or a red-background failure,
// clickable to open the REPL output. Runs are silent by design — no output
// panel reveal — so this item is the run's only immediate feedback. It shows
// the most recent command only, persisting until the next one, and the token
// guard means a superseded run's late finish/clear can never overwrite or
// hide a newer run's status. A deliberate sibling of `testStatusBar.ts`: the
// presentations differ (a result value here, fail/error counts there).

export type CommandStatusBarRun =
  | { phase: "running"; name: string }
  | { phase: "done"; name: string; status: "ok" | "err"; value?: string };

export interface CommandStatusBarView {
  text: string;
  tooltip: string;
  /** Theme color id for `item.color` (e.g. "testing.iconPassed"). */
  color?: string;
  /** Theme color id for `item.backgroundColor`. Failures use the sanctioned
   *  "statusBarItem.errorBackground", which brings its own foreground —
   *  never combined with `color`. */
  backgroundColor?: string;
  command: string;
}

const SHOW_OUTPUT = "clojurePulse.showReplOutput";

/** The tooltip never becomes a scroll problem: first line, at most 100 chars. */
const MAX_TOOLTIP_VALUE = 100;

/** Pure mapping from a run to what the status-bar item should render. */
export function commandStatusBarPresentation(
  run: CommandStatusBarRun,
): CommandStatusBarView {
  if (run.phase === "running") {
    return {
      text: `$(loading~spin) ${run.name}`,
      tooltip: `Clojure Pulse: running ${run.name}…`,
      command: SHOW_OUTPUT,
    };
  }
  if (run.status === "ok") {
    const value = truncate(run.value);
    return {
      text: `$(check) ${run.name}`,
      tooltip:
        value === undefined
          ? `Clojure Pulse: ${run.name} succeeded — click to show REPL output`
          : `Clojure Pulse: ${run.name} ⇒ ${value} — click to show REPL output`,
      color: "testing.iconPassed",
      command: SHOW_OUTPUT,
    };
  }
  return {
    text: `$(error) ${run.name} — failed`,
    tooltip: `Clojure Pulse: ${run.name} failed — click to show REPL output`,
    backgroundColor: "statusBarItem.errorBackground",
    command: SHOW_OUTPUT,
  };
}

function truncate(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const line = value.split("\n", 1)[0];
  const clipped = line.length > MAX_TOOLTIP_VALUE || line !== value;
  return clipped ? `${line.slice(0, MAX_TOOLTIP_VALUE)}…` : line;
}

export interface CommandStatusBar {
  /** Shows the spinner for a new run, superseding any earlier one. Returns
   *  the run's token, which finish/clear must present. */
  running(name: string): string;
  /** Resolves the run into its verdict. A no-op for superseded tokens. */
  finish(token: string, run: CommandStatusBarRun): void;
  /** Hides the item — for runs abandoned before a verdict. A no-op for
   *  superseded tokens. */
  clear(token: string): void;
  /** The rendered view, for tests; undefined while hidden. */
  current(): CommandStatusBarView | undefined;
  dispose(): void;
}

/** Sits just right of the test item (priority 98; higher is further left). */
export function createCommandStatusBar(): CommandStatusBar {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 97);
  item.name = "Clojure Pulse Command";
  let currentToken: string | undefined;
  let view: CommandStatusBarView | undefined;
  let nextToken = 1;

  const render = (next: CommandStatusBarView | undefined): void => {
    view = next;
    if (!next) {
      item.hide();
      return;
    }
    item.text = next.text;
    item.tooltip = next.tooltip;
    item.command = next.command;
    item.color = next.color ? new vscode.ThemeColor(next.color) : undefined;
    item.backgroundColor = next.backgroundColor
      ? new vscode.ThemeColor(next.backgroundColor)
      : undefined;
    item.show();
  };

  return {
    running(name) {
      currentToken = `command-bar-${nextToken++}`;
      render(commandStatusBarPresentation({ phase: "running", name }));
      return currentToken;
    },
    finish(token, run) {
      if (token !== currentToken) {
        return;
      }
      render(commandStatusBarPresentation(run));
    },
    clear(token) {
      if (token !== currentToken) {
        return;
      }
      render(undefined);
    },
    current() {
      return view;
    },
    dispose() {
      item.dispose();
    },
  };
}
