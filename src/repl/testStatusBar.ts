import { createStatusSlot, StatusSlot, StatusSlotView } from "./statusSlot";

// The last test command's verdict in the status bar: a spinner while the run
// is in flight, then a green pass or a red-background fail with its counts,
// clickable to open the REPL output. The verdict mirrors the gutter marks'
// invariant — it shows the most recent run only, persisting until the next
// one — while the item itself and its token guard live in the slot, shared
// with the command bar in the extension: whichever ran last owns the display,
// and a superseded run's late finish/clear is a no-op.

/** Fail/error counts parsed from a summary map value, null when absent. */
export function testRunCounts(
  value: string | undefined,
): { fail: number; error: number } | null {
  if (value === undefined) {
    return null;
  }
  const fail = value.match(/:fail\s+(\d+)/);
  const error = value.match(/:error\s+(\d+)/);
  if (!fail && !error) {
    return null;
  }
  return {
    fail: fail ? Number(fail[1]) : 0,
    error: error ? Number(error[1]) : 0,
  };
}

export type TestStatusBarRun =
  | { phase: "running"; name: string }
  | {
      phase: "done";
      name: string;
      status: "pass" | "fail";
      fail: number;
      error: number;
    };

export type TestStatusBarView = StatusSlotView;

const SHOW_OUTPUT = "clojurePulse.showReplOutput";

/** Pure mapping from a run to what the status-bar item should render. */
export function testStatusBarPresentation(run: TestStatusBarRun): TestStatusBarView {
  if (run.phase === "running") {
    return {
      text: `$(loading~spin) ${run.name}`,
      tooltip: `Clojure Pulse: running ${run.name}…`,
      command: SHOW_OUTPUT,
    };
  }
  if (run.status === "pass") {
    return {
      text: `$(testing-passed-icon) ${run.name}`,
      tooltip: `Clojure Pulse: ${run.name} passed — click to show REPL output`,
      color: "testing.iconPassed",
      command: SHOW_OUTPUT,
    };
  }
  const parts: string[] = [];
  if (run.fail > 0) {
    parts.push(`${run.fail} ${run.fail === 1 ? "fail" : "fails"}`);
  }
  if (run.error > 0) {
    parts.push(`${run.error} ${run.error === 1 ? "error" : "errors"}`);
  }
  // No counts means the run itself errored before clojure.test could count.
  const suffix = parts.length > 0 ? parts.join(", ") : "error";
  return {
    text: `$(testing-failed-icon) ${run.name} — ${suffix}`,
    tooltip: `Clojure Pulse: ${run.name} failed — click to show REPL output`,
    backgroundColor: "statusBarItem.errorBackground",
    command: SHOW_OUTPUT,
  };
}

export interface TestStatusBar {
  /** Shows the spinner for a new run, superseding any earlier one. Returns
   *  the run's token, which finish/clear must present. */
  running(name: string): string;
  /** Resolves the run into its verdict. A no-op for superseded tokens. */
  finish(token: string, run: TestStatusBarRun): void;
  /** Hides the item — for runs abandoned before a verdict. A no-op for
   *  superseded tokens. */
  clear(token: string): void;
  /** The rendered view, for tests; undefined while hidden. */
  current(): TestStatusBarView | undefined;
  dispose(): void;
}

/** A presenter over the given slot — the shared one in the extension, or a
 *  private item when created standalone. */
export function createTestStatusBar(
  slot: StatusSlot = createStatusSlot({ name: "Clojure Pulse Test", priority: 98 }),
): TestStatusBar {
  return {
    running(name) {
      return slot.show(testStatusBarPresentation({ phase: "running", name }));
    },
    finish(token, run) {
      slot.update(token, testStatusBarPresentation(run));
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
