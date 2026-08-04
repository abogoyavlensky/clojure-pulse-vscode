# Run Last Test Command Implementation Plan

> **For agentic workers:** Use executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `clojurePulse.rerunLastTest` command that re-runs whatever test command ran last (Run Test at Cursor or Run Tests in Namespace) without switching to the test file, with the usual status-bar and gutter feedback.

**Tech Stack:** TypeScript, VS Code extension API, mocha via `@vscode/test-cli` (integration tests against the fake nREPL server).

---

## Design

### The problem

Both test commands are editor-centric: they read the active editor's buffer and cursor. The Cursive workflow this feature copies is: run a specific test, switch to a business-logic file, change something, eval it in the REPL, then re-run that same test — without ever leaving the business-logic file.

### Approach — semantic replay

Record what the last test command *meant*, not a closure over how it ran:

```ts
type LastTestCommand =
  | { kind: "single"; uri: vscode.Uri; ns: string | undefined; testName: string }
  | { kind: "ns"; uri: vscode.Uri };
```

Each test command stores its record at the moment it successfully locates something to run (a deftest at cursor; a buffer with at least one deftest) — the record is written inside the document-centric cores, right after that locate check, never before it. A rerun therefore re-records the same values, which is a harmless no-op. The new command re-resolves the record against the document's **current** content:

1. Open the document with `vscode.workspace.openTextDocument(uri)` — returns the live in-memory buffer when the file is open anywhere, reads from disk otherwise, and never changes focus.
2. `kind: "single"`: find the deftest via `testsInText` from `src/repl/forms.ts`, matching **both** `found.name === testName` and `nsBefore(text, found.range.start) === ns`. Name alone is not enough: a buffer can hold several `ns` forms, and two namespaces may define same-named tests. The test may have moved or changed; namespace + name is the identity.
3. `kind: "ns"`: re-enumerate all deftests, exactly like Run Tests in Namespace does.
4. Run the same pipeline as the original command: same probe/load/in-ns/define/run sequence, same status-bar spinner and verdict, same gutter marks, same REPL output streaming.

### Refactor — document-centric cores

Split each existing command in `src/extension.ts` into:

- a thin **command wrapper** that resolves the active editor and cursor, records `LastTestCommand`, and delegates;
- a **document-centric core** shared with rerun: `runSingleTest(doc, found, …)` (the body of today's `runTestAtCursor` after the cursor lookup) and `runTestsInDocument(doc, …)` (the body of today's `runNsTests` after the editor lookup).

Supporting changes:

- `TestStatusManager.track(editor, range)` → `track(document, range)`. It only reads `editor.document.uri` today, so this is a mechanical signature change.
- Inline pending decorations need a `TextEditor`. The cores look one up with a helper (`visibleEditorFor(doc)`: first entry in `vscode.window.visibleTextEditors` whose document is `doc`). When none is visible — the normal rerun case — inline decorations are skipped; the status bar and gutter marks carry the verdict. Invoked from the original commands the active editor qualifies, so current behavior is unchanged.
- `sourceParams(editor, position)` gets a document-based equivalent (it only reads `editor.document.uri`).

### Key decisions

1. **Re-locate by namespace + name, not by stored offset** — survives edits to the test file and disambiguates same-named tests across multiple `ns` forms. A renamed/deleted test → status-bar message `Clojure Pulse: deftest <name> no longer found in <file>`; the record is kept.
2. **Rerun never opens or focuses the test file** — that is the point of the feature.
3. **In-memory, per-window state** — a VS Code restart clears the record. No `workspaceState` persistence (YAGNI).
4. **Repeated reruns are stable** — the cores re-record the same semantic values on a rerun, so the record never drifts.
5. **No auto-reload of business logic** — same semantics as the existing commands: the user evals their changes in the REPL, then reruns.
6. **No default keybinding** — consistent with the existing test commands. Command palette title: "Run Last Test Command".

### Edge cases

- No test command run yet → `vscode.window.setStatusBarMessage("Clojure Pulse: no test command has been run yet", 3000)`.
- `openTextDocument` rejects (file deleted since) → `vscode.window.showErrorMessage` via the existing `reportRunError` style.
- No active/connected REPL → same silent-return-with-warning path as the existing commands (`activeSession(registry)` already handles it).
- Single-test rerun where the name is gone → status-bar message, record kept (decision 1).
- Ns rerun where the buffer no longer has deftests → the existing "no deftests in this file" status-bar message.

### Testing strategy

Integration tests in `src/test/replCommands.integration.test.ts`, following the existing pattern (fake nREPL server, `executeCommand`, assertions on sent evals, `TestStatusManager.marks()`, and `TestStatusBar` state). Unit tests are not needed: the new logic is command wiring plus a record, and the re-location logic reuses the already-tested `testsInText`.

## File Structure

- Modify: `src/extension.ts` — extract document-centric cores, add `LastTestCommand` record + module-level state, register `clojurePulse.rerunLastTest`, document-based `sourceParams` variant, `visibleEditorFor` helper.
- Modify: `src/repl/testStatus.ts` — `track` takes a `TextDocument`.
- Modify: `src/test/testStatus.test.ts` — callers of `track` pass a document.
- Modify: `package.json` — declare the new command.
- Modify: `src/test/replCommands.integration.test.ts` — new tests + the registered-commands list.
- Modify: `README.md`, `CHANGELOG.md` — document the command.

All test runs use `make test` (wraps `npm test` with xvfb on Linux). It compiles and lints first via `pretest`.

---

### Task 1: `TestStatusManager.track` takes a document

**Files:**
- Modify: `src/repl/testStatus.ts`
- Modify: `src/test/testStatus.test.ts`
- Modify: `src/extension.ts` (call sites)

- [ ] **Step 1: Change the signature**
  In `src/repl/testStatus.ts`, change `track(editor: vscode.TextEditor, range: vscode.Range)` to `track(document: vscode.TextDocument, range: vscode.Range)` and build the mark's `uri` from `document.uri`. Update the doc comment.

- [ ] **Step 2: Update callers**
  In `src/extension.ts`, both `testStatus.track(editor, …)` call sites pass `editor.document`. In `src/test/testStatus.test.ts`, every `manager.track(editor, …)` passes the editor's document.

- [ ] **Step 3: Run the tests**
  Run: `make test`
  Expected: PASS (pure refactor, no behavior change).

- [ ] **Step 4: Commit**
  `git commit -m "refactor: track test marks by document, not editor"`

### Task 2: Extract document-centric cores from the test commands

**Files:**
- Modify: `src/extension.ts`

- [ ] **Step 1: Extract `runSingleTest`**
  Split `runTestAtCursor` into:
  - `runTestAtCursor(…)` (wrapper): resolves the active editor and cursor, calls `testAtCursor`, shows the existing "no deftest found at cursor" message, then delegates.
  - `runSingleTest(session, doc: vscode.TextDocument, found: TestAtCursor, …)` (core): everything from the `beginRun()` block down, rewritten against `doc` instead of `editor` — ranges via `doc.positionAt`, code via `doc.getText(range)`, `testStatus.track(doc, range)`.
  Inline decorations: `const editor = visibleEditorFor(doc)` (new helper: first visible editor whose document is `doc`); mark pending only when `inlineEnabled()` **and** an editor was found. Add a document-based `sourceParams` variant (same fields, from `doc.uri` + position) and use it in the core.

- [ ] **Step 2: Extract `runTestsInDocument`**
  Same split for `runNsTests`: the wrapper resolves the active editor and delegates; the core `runTestsInDocument(session, doc, …)` takes the document, computes `testsInText`, shows the existing "no deftests in this file" message when empty, and runs the existing load/in-ns/per-test loop against `doc`.

- [ ] **Step 3: Run the tests**
  Run: `make test`
  Expected: PASS — the existing `runTestAtCursor`/`runNsTests` integration tests cover both wrappers end to end.

- [ ] **Step 4: Commit**
  `git commit -m "refactor: document-centric cores for test commands"`

### Task 3: Record the last test command and add the rerun command

**Files:**
- Modify: `src/extension.ts`
- Modify: `package.json`

- [ ] **Step 1: Add the record**
  In `src/extension.ts`, add the `LastTestCommand` type (shape from the Design section) and a module-level `let lastTestCommand: LastTestCommand | undefined`. Set it inside the cores, after each one's locate check, so a command that found nothing to run never clobbers a valid record:
  - in `runSingleTest`, where `nsName` is computed: `{ kind: "single", uri: doc.uri, ns: nsName, testName: found.name }`;
  - in `runTestsInDocument`, right after the `testsInText` non-empty check: `{ kind: "ns", uri: doc.uri }`.
  A rerun flows through the same cores and re-records identical values — a deliberate no-op (Design decision 4).

- [ ] **Step 2: Implement `rerunLastTest`**
  New function following the Design section: no record → status-bar hint; `openTextDocument` failure → error message via the `reportRunError` pattern; `kind: "single"` → find the entry in `testsInText(doc.getText())` whose name matches `record.testName` **and** whose `nsBefore` matches `record.ns`, missing → status-bar message with the test name, found → `runSingleTest`; `kind: "ns"` → `runTestsInDocument`.

- [ ] **Step 3: Register and declare the command**
  Register `clojurePulse.rerunLastTest` alongside the other test commands in `activate`. In `package.json` `contributes.commands`, add it with title `Run Last Test Command` (same `category` pattern as the neighboring entries).

- [ ] **Step 4: Compile and lint**
  Run: `npm run compile && npm run lint`
  Expected: clean.

- [ ] **Step 5: Commit**
  `git commit -m "feat: add Run Last Test Command"`

### Task 4: Integration tests

**Files:**
- Modify: `src/test/replCommands.integration.test.ts`

- [ ] **Step 1: Write the tests**
  Add `clojurePulse.rerunLastTest` to the registered-commands list test. New tests, using the existing fake-nREPL helpers:
  - **Rerun with no prior test command** does not throw and sends no evals (fresh suite state; the module-level record survives across tests in one host, so run this scenario first or reset via the ordering the suite already relies on).
  - **Rerun repeats a single-test run from another file**: open a test buffer, run `runTestAtCursor`, then open and focus a different (non-test) document, execute `rerunLastTest`, and assert the fake server received the same define + runner evals again, the status bar finished with the test's verdict, and `vscode.window.activeTextEditor` still shows the non-test document — the feature's focus-preservation promise.
  - **Rerun repeats an ns run**: same shape with `runNsTests`.
  - **Renamed test**: after a single-test run, edit the buffer to rename the deftest, execute `rerunLastTest`, assert no runner eval is sent.

- [ ] **Step 2: Run the tests**
  Run: `make test`
  Expected: PASS, including the new tests.

- [ ] **Step 3: Commit**
  `git commit -m "test: cover Run Last Test Command"`

### Task 5: Documentation

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Document the command**
  README: add **Run Last Test Command** next to the two existing test commands (both in the feature section around line 225 and the command list around line 317) — one short paragraph: re-runs the last test command from anywhere, without switching to the test file. CHANGELOG: add an entry under the unreleased section, matching the style of the existing test-command entries. Use /writing-clearly.

- [ ] **Step 2: Commit**
  `git commit -m "docs: document Run Last Test Command"`
