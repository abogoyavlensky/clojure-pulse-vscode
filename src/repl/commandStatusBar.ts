import { createStatusSlot, StatusSlot, StatusSlotView } from "./statusSlot";

// The last silent run's verdict in the status bar — a custom REPL command or
// an Evaluate File: a spinner while the eval is in flight, then a green check
// or a red-background failure, clickable to open the REPL output. Those runs
// never reveal the output panel, so this verdict is their only immediate
// feedback, and a failure's reason rides along in the tooltip. A
// deliberate sibling of `testStatusBar.ts`: the presentations differ (a
// result value here, fail/error counts there), while the item itself and its
// token guard live in the slot — shared with the test bar in the extension,
// so whichever ran last owns the display.

export type CommandStatusBarRun =
  | { phase: "running"; name: string }
  | {
      phase: "done";
      name: string;
      status: "ok" | "err";
      value?: string;
      /** Why the run failed, when it did — the tooltip is the only place a
       *  silent run's reason shows up. */
      error?: string;
    };

export type CommandStatusBarView = StatusSlotView;

const SHOW_OUTPUT = "clojurePulse.showReplOutput";

/** The tooltip never becomes a scroll problem: first line, at most 100 chars.
 *  Applies to a result value and to a failure's reason alike. */
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
  const reason = truncate(run.error);
  return {
    text: `$(error) ${run.name} — failed`,
    tooltip:
      reason === undefined
        ? `Clojure Pulse: ${run.name} failed — click to show REPL output`
        : `Clojure Pulse: ${run.name} failed — ${reason} — click to show REPL output`,
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

/** A presenter over the given slot — the shared one in the extension, or a
 *  private item when created standalone. */
export function createCommandStatusBar(
  slot: StatusSlot = createStatusSlot({ name: "Clojure Pulse Command", priority: 97 }),
): CommandStatusBar {
  return {
    running(name) {
      return slot.show(commandStatusBarPresentation({ phase: "running", name }));
    },
    finish(token, run) {
      slot.update(token, commandStatusBarPresentation(run));
    },
    clear(token) {
      slot.clear(token);
    },
    current() {
      return slot.current();
    },
    dispose() {
      slot.dispose();
    },
  };
}
