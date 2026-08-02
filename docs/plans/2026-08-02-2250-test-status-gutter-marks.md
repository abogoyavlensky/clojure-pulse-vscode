# Test Status Gutter Marks Implementation Plan

> **For agentic workers:** Use executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cursive-style gutter marks on `deftest` forms — a green check circle on pass, a red cross circle on fail with the failure report on hover — always showing the result of the *last test command* only.

**Tech Stack:** TypeScript VS Code extension (TextEditorDecorationType with `gutterIconPath`), mocha (tdd ui) via `@vscode/test-cli`.

---

## Design

Settled in discussion with the user (see the screenshot in `screenshots/` for the Cursive reference):

### Semantics: the gutter shows the last test command's report

- **One invariant:** every visible mark comes from the most recent test command. Today that command is Run Test at Cursor, so at most one mark is visible; a future "run all tests in ns" reports N marks under the same rule with no semantic change.
- **Wipe at command start.** Invoking a test command clears all previous marks the moment the run actually starts (a resolved deftest and a connected session — a command that finds no deftest wipes nothing). The gutter never shows a superseded report while a run is in flight; the inline `…` pending hint already indicates activity.
- **Marks are not cleared by Escape / Clear Inline Results** — they leave only via the next test command, an edit to their deftest, or the document closing. No manual dismiss (deliberate; a dedicated command can come later if wanted).
- **Edits:** marks shift with document edits and are dropped when an edit overlaps their deftest form — a stale verdict is worse than none. This is the existing `shiftRange` machinery (`src/repl/inlineResults.ts:102`, exported).
- **Runs that never reach the test** (no session, probe/load/define failure, transport error mid-run) report no mark; the inline error decoration already tells that story. Combined with wipe-at-start, a failed attempt leaves an empty gutter.

### Components

1. **`EvalOutcome.out` capture** (`src/repl/connectionManager.ts`): a new optional `out` field, all `out` chunks concatenated in arrival order — exactly how `err` is accumulated in `collectEvalMessage`. This carries the clojure.test `FAIL in (...) expected/actual` report (today transcript-only) to the hover.

2. **`TestStatusManager`** (new `src/repl/testStatus.ts`), modeled on `InlineResultsManager` but smaller:
   - Two `TextEditorDecorationType`s with `gutterIconPath` (pass/fail icon URIs injected via the constructor so the module has no `extensionUri` knowledge).
   - State: the current run's marks — `{ uri, range (whole deftest form, SimpleRange), status: "pass" | "fail" | "pending", hover: string }`. The icon renders on the form's **first line**; the full range exists for edit overlap/shift. A `pending` mark renders **no icon** — it exists so edits during the run shift/drop it like any other mark.
   - API shape, id-based like `InlineResultsManager` so in-flight races resolve safely (pinned so command and tests agree):
     ```ts
     /** Wipes all marks (a new test command supersedes the report) and
      *  registers an invisible pending mark for the deftest. Returns its id. */
     beginRun(editor: vscode.TextEditor, range: vscode.Range): string;
     /** Resolves a pending mark. No-op when the id is gone: superseded by a
      *  later beginRun, dropped by an edit, or its document closed — a stale
      *  run can never paint a mark. */
     report(id: string, status: "pass" | "fail", hover: string): void;
     marks(): ReadonlyArray<{ uri: string; line: number; status: "pass" | "fail"; hover: string }>; // for tests; excludes pending
     dispose(): void;
     ```
   - Listeners as in `InlineResultsManager`: `onDidChangeTextDocument` (shift/drop via `shiftRange`), `onDidCloseTextDocument` (forget), `onDidChangeVisibleTextEditors` (re-render).
   - Hover: a `MarkdownString` with the text in a `clojure` fence (untrusted, no command links — simpler than the inline-results hover).

3. **Status + hover mapping** (pure, exported from `testStatus.ts` for unit tests):
   - fail when the runner outcome has `err` or `testRunFailed(value)`; pass otherwise.
   - fail hover: `out` + `err` concatenated (trimmed); pass hover: the summary map `value`.

4. **Icons**: `images/test-pass.svg`, `images/test-fail.svg` — 16×16 filled circles (green `#2ea043` with a white check; red `#f14c4c` with a white cross), fixed colors across themes like VS Code's own testing icons. `extension.ts` builds the URIs with `vscode.Uri.joinPath(context.extensionUri, "images", ...)` (the `ReplFormPanel` icon precedent).

5. **Wiring** (`src/extension.ts`): create the manager in `setupRepl`, push to subscriptions, expose on `ExtensionApi` (as `testStatus`) for integration tests. In `runTestAtCursor`: call `beginRun(editor, range)` right before the probe/define sequence starts and keep the returned id; after the runner outcome resolves, call `report(id, ...)` with the mapped status/hover. The transport-error catch path and the early-return paths (probe/load/define failure) report nothing — the pending mark simply never resolves and vanishes on the next `beginRun`.

### Testing strategy

- Unit: `out` accumulation across chunks (in `src/test/connectionManager.test.ts`, next to the existing out/err streaming tests at line 109); status/hover mapping in a new `src/test/testStatus.test.ts`.
- Integration (`src/test/replCommands.integration.test.ts`): green mark after a passing run; red mark + hover containing the FAIL report when the runner replies `out` chunks and a `:fail 1` summary; a second run wipes the first run's mark (two documents); no mark when the define fails.
- Manager-level race coverage (in `src/test/testStatus.test.ts`, which runs in the extension host and can open real editors): `report` after a later `beginRun` paints nothing (stale-run supersede); an edit overlapping the pending mark's deftest during the run drops it, so the late `report` is a no-op; a document close during the run likewise.

## File Structure

- **Modify `src/repl/connectionManager.ts`** — `out` field on `EvalOutcome`, accumulated in `collectEvalMessage`.
- **Create `src/repl/testStatus.ts`** — `TestStatusManager` + pure status/hover helpers.
- **Create `images/test-pass.svg`, `images/test-fail.svg`** — gutter icons.
- **Modify `src/extension.ts`** — manager wiring, `beginRun`/`report` calls in `runTestAtCursor`, `ExtensionApi.testStatus`.
- **Create `src/test/testStatus.test.ts`**; **modify `src/test/connectionManager.test.ts`, `src/test/replCommands.integration.test.ts`**.
- **Modify `README.md`, `CHANGELOG.md`**.

## Tasks

### Task 1: Capture eval `out` in the outcome

**Files:**
- Modify: `src/repl/connectionManager.ts`
- Test: `src/test/connectionManager.test.ts`

- [ ] **Step 1: Write the failing test**
  Next to "eval streams out and err entries": an eval whose reply sends two `out` chunks then a value resolves with `outcome.out` equal to the chunks concatenated in order; an eval with no `out` messages leaves `outcome.out` undefined.

- [ ] **Step 2: Run tests to verify it fails**
  Run: `npm run compile-tests && xvfb-run -a npm test`
  Expected: FAIL — `out` is not on `EvalOutcome`.

- [ ] **Step 3: Implement**
  Optional `out` on `EvalOutcome` (doc comment mirroring `err`'s), accumulated in `collectEvalMessage` from the sanitized message — after ANSI stripping, like the transcript sees it.

- [ ] **Step 4: Run tests to verify they pass**
  Run: `npm run compile-tests && xvfb-run -a npm test`
  Expected: PASS.

- [ ] **Step 5: Commit**
  `git commit -m "Capture eval out chunks in the outcome"`

### Task 2: TestStatusManager, icons, and command wiring

**Files:**
- Create: `src/repl/testStatus.ts`, `images/test-pass.svg`, `images/test-fail.svg`, `src/test/testStatus.test.ts`
- Modify: `src/extension.ts`
- Test: `src/test/replCommands.integration.test.ts`

- [ ] **Step 1: Write the failing tests**
  - `testStatus.test.ts`: status mapping (err → fail; `:fail 1` value → fail; clean summary → pass) and hover building (fail combines out + err trimmed; pass shows the value).
  - Integration: the four command-level scenarios from the Testing strategy, inspecting `api.testStatus.marks()` (uri/line/status/hover).
  - Manager-level race tests per the Testing strategy: stale `report` after a newer `beginRun`, edit-during-run dropping the pending mark, document close during the run.

- [ ] **Step 2: Run tests to verify they fail**
  Run: `npm run compile-tests && xvfb-run -a npm test`
  Expected: FAIL — module and API do not exist.

- [ ] **Step 3: Implement**
  `TestStatusManager` per Design §2-3, SVGs per Design §4, wiring per Design §5.

- [ ] **Step 4: Run tests and lint**
  Run: `npm run pretest && xvfb-run -a npm test`
  Expected: PASS, no lint errors.

- [ ] **Step 5: Commit**
  `git commit -m "Add test status gutter marks"`

### Task 3: Docs and final verification

**Files:**
- Modify: `README.md`, `CHANGELOG.md`

- [ ] **Step 1: Update the docs**
  README (Run Test at Cursor bullet): the gutter shows a green check / red cross circle for the last test run, failure details on hover; marks reflect only the most recent test command. CHANGELOG: extend the Unreleased Run Test at Cursor entry.

- [ ] **Step 2: Full suite**
  Run: `npm run pretest && xvfb-run -a npm test`
  Expected: PASS.

- [ ] **Step 3: Commit**
  `git commit -m "Document test status gutter marks"`
