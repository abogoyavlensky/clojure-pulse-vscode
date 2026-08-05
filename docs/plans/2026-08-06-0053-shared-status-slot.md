# Shared Status-Bar Slot Implementation Plan

> **For agentic workers:** Use executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merge the test-verdict and custom-command-verdict status bar items into one shared slot showing the last run of either kind, so verdicts never sit side by side and staleness is bounded to one item.

**Tech Stack:** TypeScript, VS Code `StatusBarItem`, existing modules `testStatusBar.ts` / `commandStatusBar.ts`, mocha via `vscode-test`.

---

## Design

### Overview

Today `testStatusBar.ts` and `commandStatusBar.ts` each own a `vscode.StatusBarItem`
(priorities 98 and 97) with an identical render-plus-token-guard skeleton; each persists its
last verdict until superseded *within its own kind*, so after one test run and one command run
two verdicts sit side by side forever, with no way to clear either.

This plan extracts that shared skeleton into a **status slot** — one item, one globally
ordered token sequence — and turns both bars into thin presenters rendering into it. The
shared slot shows the verdict of the last thing you ran, test or command. The REPL connection
item (`nREPL <name>`, priority 99) and the clj-pulse server item stay separate: they are a
connection indicator and a server indicator, not run verdicts.

### Key decisions

1. **New module `statusSlot.ts`** owns item creation (`createStatusSlot({ name, priority })`),
   rendering, and the token guard. The `running`/`finish`/`clear` token semantics move here
   unchanged; tokens are ordered globally across every presenter sharing the slot.
2. **Factories keep their interfaces.** `createTestStatusBar(slot?)` and
   `createCommandStatusBar(slot?)` keep `running`/`finish`/`clear`/`current`/`dispose` and
   their own presentation functions. With no argument they create a private slot (existing
   unit tests keep working standalone); `extension.ts` passes one shared slot to both.
3. **Shared item identity:** name "Clojure Pulse Run", priority 98 — where the test item sits
   today, just right of the REPL item. The priority-97 command item is gone.
4. **Accepted edge:** a slow run finishing after a newer run of the *other* kind gets its bar
   update dropped as stale — the same supersession overlapping test runs already have. No
   information is lost: test verdicts also land in gutter marks and hovers, command results in
   the transcript.
5. **`ExtensionApi` keeps both fields.** `testStatusBar.current()` and
   `commandStatusBar.current()` now read the same slot, which is what integration tests
   assert against.
6. **No clear command** (YAGNI — a single slot bounds staleness to one item). Possible
   follow-up if it still itches.
7. **Dispose:** both bars delegate `dispose()` to the slot. `StatusBarItem.dispose()` is
   idempotent, so both bars sitting in `context.subscriptions` is harmless.

### Shapes (shared between tasks)

```ts
// statusSlot.ts
export interface StatusSlotView {
  text: string;
  tooltip: string;
  color?: string;           // theme color id
  backgroundColor?: string; // theme color id
  command: string;
}
export interface StatusSlot {
  /** Shows `view`, superseding whatever is displayed. Returns the token. */
  show(view: StatusSlotView): string;
  /** Re-renders for `token`'s run. A no-op for superseded tokens. */
  update(token: string, view: StatusSlotView): void;
  /** Hides the item. A no-op for superseded tokens. */
  clear(token: string): void;
  current(): StatusSlotView | undefined;
  dispose(): void;
}
export function createStatusSlot(options: { name: string; priority: number }): StatusSlot;
```

`TestStatusBarView` and `CommandStatusBarView` are structurally identical to
`StatusSlotView`; the bars keep exporting their own view types (aliases are fine) so no
caller changes.

### Testing strategy

TDD. Slot unit tests cover show/update/clear token ordering, including cross-presenter
supersession. The existing `testStatusBar.test.ts` and `commandStatusBar.test.ts` suites keep
passing with at most mechanical changes (standalone default slots). One new unit test drives
both bars into a single slot. One integration test runs a deftest then a custom command and
asserts the slot shows the command verdict through both API fields.

## File Structure

- Create: `src/repl/statusSlot.ts` — the shared item + token guard.
- Modify: `src/repl/testStatusBar.ts` — render into a slot; presentation unchanged.
- Modify: `src/repl/commandStatusBar.ts` — same.
- Modify: `src/extension.ts` — create one shared slot, pass to both factories.
- Modify: `README.md` — the test bullet and the Custom commands section each get a line
  saying the verdict slot shows the last run of either kind.
- Create: `src/test/statusSlot.test.ts`.
- Modify: `src/test/testStatusBar.test.ts`, `src/test/commandStatusBar.test.ts` (only as
  needed), `src/test/customCommands.integration.test.ts` (cross-kind integration test).

Test command throughout: `make test`. Full gate: `make check`.

---

### Task 1: The status slot

**Files:**
- Create: `src/repl/statusSlot.ts`
- Test: `src/test/statusSlot.test.ts`

- [ ] **Step 1: Write failing tests**
  Cover: `show` renders the view and returns a token; `update` with the current token
  re-renders; `update`/`clear` with a superseded token are no-ops; `clear` with the current
  token hides (`current()` → undefined); a second `show` supersedes the first regardless of
  which caller issued it; `dispose` is idempotent. Views with and without `color` /
  `backgroundColor` map onto the item (assert via `current()`, as the existing bar tests do).

- [ ] **Step 2: Run tests to verify they fail**
  Run: `make test`
  Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement**
  Move the render + token logic that `createTestStatusBar` holds today
  (`testStatusBar.ts:101-149`) into `createStatusSlot(options)` with the interface pinned in
  the Design section. Token prefix `slot-`.

- [ ] **Step 4: Run tests to verify they pass**
  Run: `make test`
  Expected: PASS.

- [ ] **Step 5: Commit**
  `git commit -m "feat: shared status-bar slot"`

### Task 2: Bars render into the slot

**Files:**
- Modify: `src/repl/testStatusBar.ts`, `src/repl/commandStatusBar.ts`
- Test: `src/test/commandStatusBar.test.ts` (cross-supersession), existing suites

- [ ] **Step 1: Write the failing cross-supersession test**
  In `commandStatusBar.test.ts`: create one `createStatusSlot({name: "t", priority: 98})`,
  build `createTestStatusBar(slot)` and `createCommandStatusBar(slot)`; a test verdict is
  replaced by a command `running()`; the test bar's late `finish` with its stale token is a
  no-op; both bars' `current()` return the same view. Also assert the reverse direction
  (command verdict superseded by a test run).

- [ ] **Step 2: Run tests to verify the new test fails**
  Run: `make test`
  Expected: FAIL — factories take no slot argument yet.

- [ ] **Step 3: Refactor both bars**
  Each factory becomes `create…StatusBar(slot?: StatusSlot)`, defaulting to a private
  `createStatusSlot` with its current name/priority ("Clojure Pulse Test" 98 /
  "Clojure Pulse Command" 97 — standalone behavior unchanged). `running` → `slot.show`,
  `finish` → `slot.update`, `clear` → `slot.clear`, `current` → `slot.current`,
  `dispose` → `slot.dispose`. Presentation functions and view types stay put (view types
  may alias `StatusSlotView`). Drop the now-moved item code and stale placement comments.

- [ ] **Step 4: Run tests to verify everything passes**
  Run: `make test`
  Expected: PASS, existing bar suites included (mechanical updates only if needed).

- [ ] **Step 5: Commit**
  `git commit -m "refactor: render both verdict bars through the status slot"`

### Task 3: Wire the shared slot and integrate

**Files:**
- Modify: `src/extension.ts`
- Test: `src/test/customCommands.integration.test.ts`

- [ ] **Step 1: Write the failing integration test**
  Run a deftest (borrow the minimal flow from `replCommands.integration.test.ts`: open a
  buffer with a passing deftest, `runTestAtCursor`), and first assert the slot shows the
  test verdict; then run a custom command by name and
  assert `api.commandStatusBar.current()?.text` is the command verdict and
  `api.testStatusBar.current()` returns the very same view (shared slot). Keep the existing
  teardown (settings restored, sessions dropped).

- [ ] **Step 2: Run test to verify it fails**
  Run: `make test`
  Expected: FAIL — two separate items still exist.

- [ ] **Step 3: Wire it**
  In the REPL section of `activate`: `const runSlot = createStatusSlot({ name: "Clojure
  Pulse Run", priority: 98 })`, pass it to `createTestStatusBar(runSlot)` and
  `createCommandStatusBar(runSlot)`. Both bars stay in `context.subscriptions` (double
  dispose is idempotent). No other call-site changes — the bars' interfaces are unchanged.

- [ ] **Step 4: Run tests to verify they pass**
  Run: `make test`
  Expected: PASS, all suites.

- [ ] **Step 5: Commit**
  `git commit -m "feat: one status-bar slot for test and command verdicts"`

### Task 4: Docs and final check

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Document the shared slot**
  In the **Run Test at Cursor** bullet and the **Custom commands** section, say the verdict
  spot is shared: the status bar shows the last run of either kind, and a newer run replaces
  the verdict on display. Use /writing-clearly.

- [ ] **Step 2: Full gate**
  Run: `make check`
  Expected: lint, compile, and tests all pass.

- [ ] **Step 3: Commit**
  `git commit -m "docs: shared status-bar slot"`
