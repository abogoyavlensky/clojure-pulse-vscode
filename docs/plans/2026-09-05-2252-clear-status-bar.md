# Clear Status Bar Implementation Plan

> **For agentic workers:** Use executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Command Palette command that dismisses the shared Clojure Pulse run indicator and keeps it hidden until another run starts.

**Tech Stack:** TypeScript, VS Code extension API, Mocha through `@vscode/test-cli`.

---

## Design

Add **Clojure Pulse: Clear status bar** with command ID
`clojurePulse.clearStatusBar`. Contribute it in `package.json` with title
`Clear status bar` and category `Clojure Pulse`. It is available without an
active editor or connected REPL, has no default keybinding, and silently
does nothing when the run indicator is already hidden. Follow the current
palette conventions; the separate activation-gating backlog stays out of scope.

The command clears the shared `Clojure Pulse Run` status slot created in
`setupRepl` in `src/extension.ts`. This slot presents test runs, Evaluate File,
and custom REPL commands. It can show either a spinner or a completed result.
The language-server and REPL connection indicators, configuration warnings,
inline results, test gutter marks, output channels, and last-test history
remain intact. Clearing the display does not cancel the underlying operation.

Extend `StatusSlot` in `src/repl/statusSlot.ts` with `dismiss(): void`.
Dismissal invalidates `currentToken` by setting it to `undefined` and calls
the existing renderer with `undefined`. Keep `nextToken` monotonic. All
previously issued tokens then fail the existing `update` and `clear` guards,
so late completion cannot make a dismissed result reappear or clear a later
run. The next `show` allocates a fresh token and displays normally.

Keep the existing token-scoped `clear(token)` contract for presenters.
Register the new command in `setupRepl` alongside `clearInlineResults`, with
a callback that calls `runSlot.dismiss()`. Add its disposable to the existing
`context.subscriptions` group. No new presenter method or extension test API
is needed: integration tests can inspect the shared slot through the existing
`testStatusBar.current()` and `commandStatusBar.current()` accessors.

Verification covers the token lifecycle at the slot level and the registered
command against both presenters in the extension host. The manifest test
pins the palette entry and exact label. Update the README's REPL status-bar
description to explain the command and what it dismisses.

## File Structure

| File | Change |
| --- | --- |
| `src/repl/statusSlot.ts` | Add unconditional dismissal with token invalidation. |
| `src/test/statusSlot.test.ts` | Cover dismissal, stale updates, and a subsequent run. |
| `src/extension.ts` | Register `clojurePulse.clearStatusBar` against `runSlot`. |
| `package.json` | Contribute the palette command and label. |
| `src/test/manifest.test.ts` | Add the command to `PALETTE` and check its title. |
| `src/test/replCommands.integration.test.ts` | Verify registration and dismissal through both presenters. |
| `README.md` | Document clearing the shared run indicator. |

## Implementation

Work on `clear-status-bar`, created from master at `58a2b6a`. Use
`/writing-clearly` for documentation and comments. Install dependencies with
`npm ci` if they are missing. The repository's `make test` supplies a virtual
display when `xvfb-run` is installed and runs compilation and lint through
the npm pretest hook. On headless Linux, ensure `xvfb-run` is available.

### Task 1: Dismiss the shared slot safely

**Files:** `src/repl/statusSlot.ts`, `src/test/statusSlot.test.ts`.

- [ ] **Step 1: Add lifecycle regression tests.**
  Extend the existing `StatusSlot` suite to exercise `dismiss()` while empty
  and after `show`, including repeated dismissal. Assert that `current()`
  becomes `undefined`. Keep the dismissed token, call `update` with a result,
  and assert the slot remains hidden. Start a new run and assert its token
  differs, its updates work, and the dismissed token's `update` and `clear`
  cannot affect it. These deterministic tests cover the late-completion race
  without timers or a real REPL.

- [ ] **Step 2: Verify the tests expose the missing API.**
  Run `npm run compile-tests`.
  Expected: TypeScript reports that `dismiss` does not exist on `StatusSlot`.

- [ ] **Step 3: Implement dismissal.**
  Add the documented `dismiss(): void` interface member and implement the
  token invalidation and hide operation described in Design. Preserve the
  existing `show`, `update`, and token-scoped `clear` behavior.

- [ ] **Step 4: Verify the slot change.**
  Run `make test`.
  Expected: exit 0, including the new lifecycle cases and existing presenter
  tests. Report environmental failures separately from feature regressions;
  do not remove unrelated checks or count skipped tests as verified.

- [ ] **Step 5: Commit the slot change.**
  Run `git add src/repl/statusSlot.ts src/test/statusSlot.test.ts`, then
  `git commit -m "Add dismissal to the shared run status slot"`.

### Task 2: Expose and document the command

**Files:** `src/extension.ts`, `package.json`, `src/test/manifest.test.ts`,
`src/test/replCommands.integration.test.ts`, `README.md`.

- [ ] **Step 1: Add command regression coverage.**
  Add `clojurePulse.clearStatusBar` to the integration suite's registration
  list and the manifest suite's `PALETTE` list. Assert its contributed title
  is exactly `Clear status bar` and its category is `Clojure Pulse`, extending
  the local manifest test type to include category as needed.

  Add an integration case using the already activated extension API. Start
  a test status with `api.testStatusBar.running`, finish it with a valid
  completed verdict, execute the new command, and assert both presenter
  accessors return `undefined`. Then start a command status with
  `api.commandStatusBar.running`, execute the clear command while it is
  running, and call `finish` with that token. Assert both accessors remain
  empty. Start a fresh run, finish it, and verify the result displays again.
  Execute the clear command twice while empty to confirm it succeeds without
  a connected REPL. Clear the shared display in a `finally` block so these
  cases do not leak state into later tests. Use existing presenter run shapes;
  no fake server or new exported API is required.

- [ ] **Step 2: Verify the tests fail for the missing command.**
  Run `make test`.
  Expected: the new manifest and registration/dispatch checks fail because
  the command has not yet been contributed or registered.

- [ ] **Step 3: Contribute and register the command.**
  Add the command entry to `package.json` and register its callback inside
  `setupRepl`, using the existing subscription group. Leave it palette-visible
  under the existing conventions, without a `when`, enablement condition,
  default keybinding, notification, or confirmation prompt.

- [ ] **Step 4: Document the behavior.**
  In the README's REPL **Status bar** bullet, describe the shared run indicator
  and the **Clojure Pulse: Clear status bar** command. Explain that clearing
  dismisses the current spinner or result, the underlying run continues, and
  the next run shows a new status. State that connection indicators remain
  visible. Keep this addition short.

- [ ] **Step 5: Run final verification.**
  Run `make check`, then `git diff --check`.
  Expected: both exit 0; the palette includes the new command and all slot,
  presenter, and command tests pass. Inspect the diff to confirm the callback
  only dismisses `runSlot`. No version bump or dependency change is needed.
  Repeat checks only if subsequent changes or failures justify doing so.

- [ ] **Step 6: Commit and report.**
  Run `git add src/extension.ts package.json src/test/manifest.test.ts src/test/replCommands.integration.test.ts README.md`,
  then `git commit -m "Add Clear status bar command"`.
  Mark completed steps in this plan and record verification results and any
  deviations. Commit the updated plan separately with
  `git add docs/plans/2026-09-05-2252-clear-status-bar.md` and
  `git commit -m "Record clear status bar implementation results"`.
