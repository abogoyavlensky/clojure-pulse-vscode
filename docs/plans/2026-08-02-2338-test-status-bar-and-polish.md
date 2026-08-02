# Test Status Bar and Gutter Polish Implementation Plan

> **Status: COMPLETED** (2026-08-02) — see the summary at the end.

> **For agentic workers:** Use executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop stealing focus on test failure, shrink the gutter circles to match VS Code's glyph sizing, and add a colored status-bar item showing the last test run's verdict (green pass / red-background fail, clickable to open the REPL output).

**Tech Stack:** TypeScript VS Code extension (StatusBarItem + ThemeColor, SVG gutter icons), mocha (tdd ui) via `@vscode/test-cli`.

---

## Design

Settled in discussion with the user (follow-up to `docs/plans/2026-08-02-2250-test-status-gutter-marks.md`):

### 1. No auto-reveal of the REPL output on failure

Remove the `if (testRunFailed(outcome.value)) session.showOutput()` call from `runTestAtCursor` (`src/extension.ts`). The failure story is told by the red gutter mark, the inline red result, the hover report, and the new status-bar item — the output channel opens only when the user asks (click the status item, or Show REPL Output). README/CHANGELOG sentences claiming the channel "opens automatically when anything fails" must be updated.

### 2. Smaller gutter glyphs

VS Code's own gutter glyphs occupy ~60–70% of the 16px cell; ours fill 13px. Shrink the drawing inside the existing 16×16 viewBox in `images/test-pass.svg` / `images/test-fail.svg`: circle `r≈5`, stroke width `≈1.3`, check/cross scaled to fit. No code changes (`gutterIconSize: "contain"` keeps working); this is a visual-taste change the user may iterate on once.

### 3. Test status-bar item

New `src/repl/testStatusBar.ts` following the `replStatusBar.ts` pattern exactly — a pure presentation function plus a thin `vscode` wrapper:

- **Pure parts** (unit-testable, no vscode imports):
  ```ts
  /** Fail/error counts parsed from a summary map value, null when absent. */
  export function testRunCounts(value: string | undefined): { fail: number; error: number } | null;

  export type TestStatusBarRun =
    | { phase: "running"; name: string }
    | { phase: "done"; name: string; status: "pass" | "fail"; fail: number; error: number };

  export interface TestStatusBarView {
    text: string;
    tooltip: string;
    /** Theme color id for `item.color`, e.g. "testing.iconPassed"; undefined for fail. */
    color?: string;
    /** Theme color id for `item.backgroundColor`; only "statusBarItem.errorBackground". */
    backgroundColor?: string;
    command: string;
  }
  export function testStatusBarPresentation(run: TestStatusBarRun): TestStatusBarView;
  ```
  - running: `$(loading~spin) <name>`, no colors.
  - pass: `$(testing-passed-icon) <name>`, `color: "testing.iconPassed"`.
  - fail: `$(testing-failed-icon) <name> — 1 fail` / `— 2 errors` / `— 1 fail, 1 error`; counts from `testRunCounts`; when null (eval error, no summary) the suffix is `— error`. `backgroundColor: "statusBarItem.errorBackground"` and **no `color`** — VS Code pairs the error background with its own foreground.
  - command: always `"clojurePulse.showReplOutput"` (no argument — it resolves the active session), tooltip says what happened and "click to show REPL output".
- **Wrapper** `createTestStatusBar()`: `StatusBarItem` (Left, priority 98 — just right of the REPL item at 99), `item.name = "Clojure Pulse Test"`, hidden until the first run. API — **token-guarded like `TestStatusManager`, so a stale run can never overwrite or hide a newer run's status** (the same overlap race the gutter marks solve with ids): `running(name): string` returns the run's token; `finish(token, run)` and `clear(token)` are no-ops unless the token belongs to the most recent `running(...)` call. Plus `dispose()`. Maps color ids to `new vscode.ThemeColor(...)`.

**Lifecycle, wired explicitly in `runTestAtCursor`:** `const barToken = statusBar.running(name)` next to `testStatus.beginRun(...)`; `finish(barToken, ...)` next to `testStatus.report(...)` (status from the existing `testStatusOf`, counts from `testRunCounts(outcome.value)`); `clear(barToken)` on every early-return path (probe error, load failure, in-ns failure, define failure) and in the transport-error catch — a run that never produced a verdict leaves no stale spinner, and a *superseded* run's late `finish`/`clear` is ignored. The item then **persists until the next test command** (mirroring the gutter's last-command invariant). Accepted nuance: editing a deftest removes its gutter mark but not the status-bar verdict — the bar reports the last *command*, the gutter reports location-bound verdicts.

### Testing strategy

Follow the `replStatusBar` precedent: unit tests for the pure parts (`src/test/testStatusBar.test.ts` — presentation per phase, colors, count parsing and suffix wording) plus wrapper-level token tests (a stale token's `finish`/`clear` leaves the newer run's view untouched — expose a `current(): TestStatusBarView | undefined` accessor for them). No command-level integration tests for the item itself. The existing integration suite keeps covering the command flow; the removed auto-reveal has no test asserting it (verified: no integration test checks output focus).

## File Structure

- **Modify `src/extension.ts`** — remove auto-reveal; create/wire the status bar (running/finish/clear alongside the existing `beginRun`/`report` calls); dispose via subscriptions.
- **Create `src/repl/testStatusBar.ts`** — pure presentation + counts parsing + wrapper.
- **Create `src/test/testStatusBar.test.ts`** — unit tests.
- **Modify `images/test-pass.svg`, `images/test-fail.svg`** — smaller glyphs.
- **Modify `README.md`, `CHANGELOG.md`** — no-auto-reveal wording, status-bar item.

## Tasks

### Task 1: Drop the auto-reveal and shrink the icons

**Files:**
- Modify: `src/extension.ts`, `images/test-pass.svg`, `images/test-fail.svg`, `README.md`, `CHANGELOG.md`

- [x] **Step 1: Remove the failure auto-reveal**
  Delete the `testRunFailed(...) → session.showOutput()` block in `runTestAtCursor`; drop the now-unused `testRunFailed` import if nothing else uses it there. Update the README sentence "which opens automatically when anything fails" and the matching CHANGELOG wording to say the output stays put (the status-bar item added in Task 2 is the click-path — final wording lands in Task 3).

- [x] **Step 2: Shrink the SVG glyphs**
  Per Design §2 (circle `r≈5`, stroke `≈1.3`, paths scaled toward the center).

- [x] **Step 3: Run the full suite**
  Run: `npm run pretest && xvfb-run -a npm test`
  Expected: PASS (no test asserts the auto-reveal).

- [x] **Step 4: Commit**
  `git commit -m "Stop revealing the output on test failure and shrink gutter icons"`
  > Deviation: codex flagged two P3 docs nits — the "without stealing focus" claim needs qualifying for the inline-results-off path (output still shown up front, as with all eval commands), folded into Task 3's wording; and the doc comment's status-bar mention becomes true in Task 2.

### Task 2: Test status-bar item

**Files:**
- Create: `src/repl/testStatusBar.ts`, `src/test/testStatusBar.test.ts`
- Modify: `src/extension.ts`

- [x] **Step 1: Write the failing unit tests**
  `testRunCounts`: summary with `:fail 1`/`:error 2` → counts; `"nil"`/undefined → null. `testStatusBarPresentation`: running spinner text; pass text + `testing.iconPassed` color + no background; fail suffix variants (`1 fail`, `2 errors`, `1 fail, 1 error`, bare `error` when counts are null) + `statusBarItem.errorBackground` + no color; command always `clojurePulse.showReplOutput`. Wrapper token tests via `current()`: a second `running()` supersedes the first token — the stale `finish` and `clear` are ignored; the current token's `finish` updates the view.

- [x] **Step 2: Run tests to verify they fail**
  Run: `npm run compile-tests && xvfb-run -a npm test`
  Expected: FAIL — module does not exist.

- [x] **Step 3: Implement and wire**
  Module per Design §3; wire `running`/`finish`/`clear` into `runTestAtCursor` at the points listed in the Design (every early return and the catch), create in `setupRepl`, push to subscriptions.

- [x] **Step 4: Run tests and lint**
  Run: `npm run pretest && xvfb-run -a npm test`
  Expected: PASS, no lint errors.

- [x] **Step 5: Commit**
  `git commit -m "Show the last test run's verdict in the status bar"`

### Task 3: Docs and final verification

**Files:**
- Modify: `README.md`, `CHANGELOG.md`

- [x] **Step 1: Update the docs**
  README Run Test at Cursor bullet: the status bar shows the last run's verdict (green pass / red fail with counts), click opens the REPL output; the output no longer opens on its own. CHANGELOG: extend the Unreleased entry accordingly.
  > Deviation: also qualified the "without stealing focus" claim for the inline-results-off path, per Task 1's codex note.

- [x] **Step 2: Full suite**
  Run: `npm run pretest && xvfb-run -a npm test`
  Expected: PASS.

- [x] **Step 3: Commit**
  `git commit -m "Document the test status bar item"`

## Completion Summary

**Implemented** on branch `run-deftest`, commits `1b61419`, `6d85848`, plus
this docs commit. (1) The output channel is no longer revealed on test
failure — it still receives the full report; focus stays in the editor
(unchanged pre-existing behavior: with inline results off, the channel is
shown up front like every eval command). (2) Gutter circles shrunk from
13px to 10px within the 16px cell to match VS Code's glyph sizing. (3) New
`src/repl/testStatusBar.ts` following the `replStatusBar` pure-presentation
pattern: spinner while a test runs, `$(testing-passed-icon) name` in
`testing.iconPassed` green on pass, `$(testing-failed-icon) name — N fail`
on `statusBarItem.errorBackground` red on failure, click →
`clojurePulse.showReplOutput`, persisting until the next test command;
token-guarded so a superseded run's late `finish`/`clear` is a no-op, with
explicit `clear` on every abandoned-run path (no stale spinner). 455 tests
passing — 13 new (counts parsing, presentation per phase, wrapper token
races).

**Issues encountered:** none blocking. Task 1's codex review raised two P3
docs nits (over-broad focus claim; a doc comment referencing the status bar
one commit early) — both resolved by Task 2/Task 3. Task 2's review was
clean on the first round; the token guard was designed in up front by the
plan-stage codex review.

**Deviations:** the two docs-wording notes recorded under Tasks 1 and 3;
no code deviations.

**What the plan could have specified better:** the interim docs wording in
Task 1 — writing an unqualified focus claim there caused the P3 findings;
plans splitting one behavior change across a code task and a later docs
task should carry the qualified wording from the start.
