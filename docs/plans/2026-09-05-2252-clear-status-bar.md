# Clear Status Bar Implementation Plan

> **For agentic workers:** Use executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

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

> Tracking deviation: This session has no TaskCreate/TaskUpdate tools. Progress
> is tracked through commentary updates and this plan.

Work on `clear-status-bar`, created from master at `58a2b6a`. Use
`/writing-clearly` for documentation and comments. Install dependencies with
`npm ci` if they are missing. The repository's `make test` supplies a virtual
display when `xvfb-run` is installed and runs compilation and lint through
the npm pretest hook. On headless Linux, ensure `xvfb-run` is available.

### Task 1: Dismiss the shared slot safely

**Files:** `src/repl/statusSlot.ts`, `src/test/statusSlot.test.ts`.

- [x] **Step 1: Add lifecycle regression tests.**
  Extend the existing `StatusSlot` suite to exercise `dismiss()` while empty
  and after `show`, including repeated dismissal. Assert that `current()`
  becomes `undefined`. Keep the dismissed token, call `update` with a result,
  and assert the slot remains hidden. Start a new run and assert its token
  differs, its updates work, and the dismissed token's `update` and `clear`
  cannot affect it. These deterministic tests cover the late-completion race
  without timers or a real REPL.

- [x] **Step 2: Verify the tests expose the missing API.**
  Run `npm run compile-tests`.
  Expected: TypeScript reports that `dismiss` does not exist on `StatusSlot`.

- [x] **Step 3: Implement dismissal.**
  Add the documented `dismiss(): void` interface member and implement the
  token invalidation and hide operation described in Design. Preserve the
  existing `show`, `update`, and token-scoped `clear` behavior.

- [x] **Step 4: Verify the slot change.**
  Run `make test`.
  Expected: exit 0, including the new lifecycle cases and existing presenter
  tests. Report environmental failures separately from feature regressions;
  do not remove unrelated checks or count skipped tests as verified.

- [x] **Step 5: Commit the slot change.**
  Run `git add src/repl/statusSlot.ts src/test/statusSlot.test.ts`, then
  `git commit -m "Add dismissal to the shared run status slot"`.

> Verification: `npm run compile-tests` failed on the missing `dismiss` API as
> expected. After implementation, `make test` passed: 825 tests in the unit
> host, with 2 optional tests pending; the jar host had 1 optional test
> pending. `CLJ_PULSE_E2E_BIN` was unset. Commit: `db48932`.
> Codex reviewed this commit and found no actionable defects.

### Task 2: Expose and document the command

**Files:** `src/extension.ts`, `package.json`, `src/test/manifest.test.ts`,
`src/test/replCommands.integration.test.ts`, `README.md`.

- [x] **Step 1: Add command regression coverage.**
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

- [x] **Step 2: Verify the tests fail for the missing command.**
  Run `make test`.
  Expected: the new manifest and registration/dispatch checks fail because
  the command has not yet been contributed or registered.

- [x] **Step 3: Contribute and register the command.**
  Add the command entry to `package.json` and register its callback inside
  `setupRepl`, using the existing subscription group. Leave it palette-visible
  under the existing conventions, without a `when`, enablement condition,
  default keybinding, notification, or confirmation prompt.

- [x] **Step 4: Document the behavior.**
  In the README's REPL **Status bar** bullet, describe the shared run indicator
  and the **Clojure Pulse: Clear status bar** command. Explain that clearing
  dismisses the current spinner or result, the underlying run continues, and
  the next run shows a new status. State that connection indicators remain
  visible. Keep this addition short.

- [x] **Step 5: Run final verification.**
  Run `make check`, then `git diff --check`.
  Expected: both exit 0; the palette includes the new command and all slot,
  presenter, and command tests pass. Inspect the diff to confirm the callback
  only dismisses `runSlot`. No version bump or dependency change is needed.
  Repeat checks only if subsequent changes or failures justify doing so.

- [x] **Step 6: Commit and report.**
  Run `git add src/extension.ts package.json src/test/manifest.test.ts src/test/replCommands.integration.test.ts README.md`,
  then `git commit -m "Add Clear status bar command"`.
  Mark completed steps in this plan and record verification results and any
  deviations. Commit the updated plan separately with
  `git add docs/plans/2026-09-05-2252-clear-status-bar.md` and
  `git commit -m "Record clear status bar implementation results"`.

> Verification: Before wiring, `make test` failed on exactly four command
> registration/dispatch and manifest checks. After wiring, `make check`
> passed with 827 tests, 2 optional tests pending in the unit host, and
> 1 optional test pending in the jar host. `git diff --check` passed.
> Implementation commit: `f7e10a1`.

> End-to-end: `xvfb-run -a node_modules/.bin/vscode-test --config .tmp/clear-status-bar-smoke.config.mjs`
> passed (1 test). In the built extension, the smoke test connected a TCP
> nREPL stand-in, ran Evaluate File, and selected the new command through
> the actual Command Palette. It cleared a completed verdict and an
> in-flight spinner, confirmed the delayed reply stayed hidden and the
> REPL stayed connected, then verified a new evaluation displayed normally.

> Review: Codex reviewed `f7e10a1` and found no actionable defects. Both task
> review checkpoints are complete; no fixup commits were needed.

## Completed

**Status: done.** Implemented on `clear-status-bar` in `db48932` and `f7e10a1`.

**What changed:** Added `clojurePulse.clearStatusBar` to the Command Palette.
The command dismisses the shared run indicator and invalidates its token.
Late completion stays hidden, and the next run displays normally. Added
lifecycle and command regression coverage and documented the behavior.

**Verification:** `make check` passed with 827 extension-host tests, and the
Command Palette smoke test passed. The optional language-server end-to-end
tests were skipped because `CLJ_PULSE_E2E_BIN` was unset (2 pending in the
unit host, 1 in the jar host). Both Codex reviews found no actionable defects.

**Issues encountered:** None beyond the expected failures before implementation.

**Deviations:** TaskCreate/TaskUpdate are unavailable in this session, so
commentary and plan checkboxes provided progress tracking. No design changes.
The required end-to-end check used a temporary script in `.tmp/` to drive
the Command Palette against the built extension and a TCP nREPL stand-in.

**What the plan could have specified better:** Include the concrete Command
Palette smoke-test procedure and note that the optional language-server
tests need `CLJ_PULSE_E2E_BIN`.
