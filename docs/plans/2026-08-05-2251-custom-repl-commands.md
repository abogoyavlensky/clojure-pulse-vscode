# Custom REPL Commands Implementation Plan

> **For agentic workers:** Use executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users define named REPL commands (e.g. `(user/reset)`), manage them in a sidebar pane with an editor-tab form, and run them from the pane, the palette, or their own keybindings.

**Tech Stack:** TypeScript, VS Code extension API (TreeDataProvider, WebviewPanel), existing nREPL session stack (`ReplRegistry` / `ReplSession`), mocha via `vscode-test`.

---

## Design

### Overview

A settings-backed feature mirroring the REPL manager's architecture: a raw array in a new
`clojurePulse.customReplCommands` setting (resource scope), a pure rules module, a webview form
opened as an editor tab, and a flat tree in the Clojure Pulse sidebar placed **between the REPL
pane and the External Libraries pane**.

Running a command goes through the existing `activeSession()` → `session.eval(code)` path with no
`ns` option. Runs are **silent**: no `showOutput()`, no notifications — there is no editor
context, so inline results don't apply, and a keybinding-invoked `(user/reset)` must not yank the
output panel open. Feedback comes from a status bar item mirroring `testStatusBar.ts` (spinner →
verdict, clickable to open the REPL output); the transcript still records everything.

**No "execute in ns" field, deliberately.** let-go's nREPL ignores the eval `ns` param (see the
comment in `extension.ts` near the `find-ns` probe in `runSingleTest`), and the primary use case is
fully-qualified forms like `(user/reset)`. The form's hint tells users to fully-qualify symbols.

### Key decisions

1. **One parameterized run command, not per-command registrations.** VS Code cannot contribute
   commands dynamically, so `clojurePulse.runCustomReplCommand` accepts the command name as
   keybinding `args`, a tree node `{name}`, or nothing (palette → quick-pick). Renaming a command
   breaks a keybinding that references it; documented, not engineered around.
2. **Clicking a row opens the edit form; running is only via the inline play icon** (and the
   context menu). Misclicks must not evaluate stateful code like `(user/stop)`.
3. **Sibling form panel, not a generalization of `ReplFormPanel`.** The commands form has two
   fields; a small dedicated panel reusing the same message protocol, CSP, and injected-deps
   pattern beats generalizing the 470-line REPL form.
4. **One pure module.** `customCommands.ts` holds parsing, form-edit rules, and tree-row
   presentation. The REPL manager's split (`replConfig.ts` / `replConfigEdit.ts`) was about size;
   two fields don't justify it. The generic-looking helpers in `replConfigEdit.ts`
   (`upsertEntry`, `removeEntry`, `indexOfShown`) are **not** refactored for sharing — ~40 lines of
   parallel code beats coupling two settings models.
5. **Same raw-array editing semantics as REPL configs:** all edits work on the raw, unfiltered
   settings array; entries the parser skips survive edits untouched; duplicate-name shadowing is
   resolved the way `indexOfShown` does in `replConfigEdit.ts`; delete removes *every* entry with
   the name.
6. **Silent runs, status bar verdict.** Every run (keybinding, palette, pane play icon) behaves
   the same: no output panel reveal, a status bar item shows spinner → verdict and persists until
   the next run supersedes it — exactly the `TestStatusBar` model, including its token guard.
   Built as a separate `commandStatusBar.ts` module rather than generalizing `testStatusBar.ts`:
   the presentations differ (fail/error counts vs. a result value), and parallel code beats
   refactoring a tested module.

### Data model

```ts
/** One entry of clojurePulse.customReplCommands, after validation. */
export interface CustomReplCommand {
  name: string; // unique, shown in the pane, referenced by keybinding args
  code: string; // Clojure code sent verbatim to the active REPL
}
```

Setting: `clojurePulse.customReplCommands`, `"scope": "resource"`, default `[]`.
Parsing skips invalid entries with a warning each (never fails the whole list), exactly like
`parseReplConfigurations`: name required/non-empty/unique, code required/non-empty. Warnings are
logged to the extension's output channel like `applyReplConfigs` does.

### Identifiers

| Thing | Id / name |
|---|---|
| Setting | `clojurePulse.customReplCommands` |
| View (sidebar pane) | `clojurePulse.customCommands`, name "REPL Commands" |
| Run command | `clojurePulse.runCustomReplCommand` ("Run Custom REPL Command") |
| Add command | `clojurePulse.addCustomReplCommand` ("Add Custom REPL Command") |
| Edit command | `clojurePulse.editCustomReplCommand` ("Edit Custom REPL Command") |
| Delete command | `clojurePulse.deleteCustomReplCommand` ("Delete Custom REPL Command") |
| Webview viewType | `clojurePulse.customCommandForm` |
| Tree item contextValue | `customReplCommand` |

### UX flows

- **Pane row:** label = name, description = first line of the code, tooltip = full code,
  icon = ThemeIcon `code`. Row click → edit form. Inline action: run (`$(play)`, `inline@1`).
  Context menu: Run (`1_run`), Edit + Delete (`2_config`).
- **Run resolution** (mirrors `resolveSessionName` in `extension.ts`): string arg from a
  keybinding, `{name}` node from the tree, else quick-pick (label = name, description = first
  line of code). Unknown name → error notification naming the setting. Palette invocation with
  nothing configured → open the add form instead of an empty pick (mirrors `startRepl`'s
  empty-registry fallback).
- **Run execution:** `activeSession(registry)` (reuses the existing "No REPL is connected"
  prompt), then `await session.eval(code)` wrapped in the status bar lifecycle: `running(name)`
  before the eval; on resolve, `finish` with success when the outcome has no `err`, failure
  otherwise; on throw (e.g. connection dropped mid-run), `finish` with failure. No session →
  return before `running()`, so nothing flashes. No `showOutput()`, no notifications.
- **Status bar item:** priority 97 — just right of the test item (98), which sits right of the
  REPL item (99); higher priority is further left. Item name "Clojure Pulse Command".
  Running: `$(loading~spin) <name>`. Success: `$(check) <name>` colored `testing.iconPassed`,
  tooltip carrying the result value truncated to its first line / 100 chars. Failure:
  `$(error) <name> — failed` with `statusBarItem.errorBackground`. All states click through to
  `clojurePulse.showReplOutput`, like the test bar's `SHOW_OUTPUT`. Persists until superseded;
  no auto-hide timers.
- **Form:** Name text input + Code textarea (monospace, `rows="5"`), hint under Code:
  "Runs in the active REPL. Use fully-qualified symbols, e.g. (user/reset)." Save / Cancel, and
  Delete on edit (with the same confirm-modal pattern as REPL configs). Same message protocol as
  `ReplFormPanel` (`ready`/`load`/`save`/`cancel`/`delete`), same CSP/nonce approach, panel reused
  across opens, `retainContextWhenHidden: true`, icon `images/repl-icon.svg`.
- **Empty pane:** `viewsWelcome` entry with an "Add Command" link, plus a one-line mention of
  assigning keybindings.
- **Keybindings:** none contributed; the setting's `markdownDescription` and README document
  `{ "key": "...", "command": "clojurePulse.runCustomReplCommand", "args": "reset" }`.

### Testing strategy

Pure modules get unit tests mirroring the existing style (`replConfig.test.ts`,
`replConfigEdit.test.ts`, `replFormPanel.test.ts` are the templates — fake panel hosts, injected
deps, no `vscode` import in the units under test). The run command gets an integration test
modeled on `replCommands.integration.test.ts` using `fakeNreplServer.ts`.

## File Structure

- Create: `src/repl/customCommands.ts` — pure: types, `parseCustomReplCommands`, form values /
  validation / entry read-write rules, tree-row presentation.
- Create: `src/repl/customCommandsTree.ts` — thin `vscode.TreeDataProvider` over the parsed
  setting, with a `refresh()` the config listener calls (pattern: `replTree.ts`, but
  settings-driven instead of registry-driven).
- Create: `src/repl/customCommandFormPanel.ts` — the editor-tab form; no `vscode` import
  (pattern: `replFormPanel.ts`).
- Create: `src/repl/commandStatusBar.ts` — pure presentation + token-guarded status bar item for
  run feedback (pattern: `testStatusBar.ts`, without the count parsing).
- Modify: `src/extension.ts` — read/write helpers for the setting, panel + tree wiring, the four
  commands, quick-pick, config-change repaint.
- Modify: `package.json` — setting schema + defaultSnippets, view (between REPL and External
  Libraries), viewsWelcome, commands, menus.
- Modify: `README.md` — feature section with the keybinding example.
- Create: `src/test/customCommands.test.ts`, `src/test/customCommandFormPanel.test.ts`,
  `src/test/customCommandsTree.test.ts`, `src/test/commandStatusBar.test.ts`,
  `src/test/customCommands.integration.test.ts`.

Test command throughout: `make test` (wraps `npm test` in xvfb on Linux). Full gate: `make check`.

---

### Task 1: Pure module — parsing and presentation

**Files:**
- Create: `src/repl/customCommands.ts`
- Test: `src/test/customCommands.test.ts`

- [x] **Step 1: Write failing tests for `parseCustomReplCommands`**
  Mirror `replConfig.test.ts`'s parser cases: undefined/null → empty with no warnings; non-array →
  one warning; valid entries pass with `name`/`code` trimmed at the name level (code kept verbatim
  apart from requiring non-blank); entries skipped with a descriptive warning when: not an object,
  name missing/blank, code missing/blank/not a string, duplicate name (first valid wins). Warning
  text identifies the entry by name or `#index` (reuse the `describe` approach).

- [x] **Step 2: Write failing tests for presentation**
  `presentCustomCommand({name, code})` returns `{label, description, tooltip, contextValue}`:
  label = name, description = first line of `code` (trimmed), tooltip = full code,
  contextValue = `"customReplCommand"`. Cover multi-line code and single-line code.

- [x] **Step 3: Run tests to verify they fail**
  Run: `make test`
  Expected: FAIL — module doesn't exist.

- [x] **Step 4: Implement types, parser, and presentation**
  `CustomReplCommand` as in the Design section; `ParsedCustomReplCommands = { commands, warnings }`.
  Pure module, no `vscode` import. Follow `replConfig.ts`'s doc-comment style.

- [x] **Step 5: Run tests to verify they pass**
  Run: `make test`
  Expected: PASS.

- [x] **Step 6: Commit**
  `git commit -m "feat: parse and present custom REPL commands"`

### Task 2: Pure module — form-edit rules

**Files:**
- Modify: `src/repl/customCommands.ts`
- Test: `src/test/customCommands.test.ts`

- [x] **Step 1: Write failing tests for the edit rules**
  Mirror `replConfigEdit.test.ts` for the two-field shape:
  - `commandFormValuesFor(entry)` → `{name, code}` strings; missing fields fall back to `""`.
  - `validateCommandFormValues(values, entries, originalName?)` → errors object: name required,
    name unique among *parseable* entries (an entry the parser skips must not block a name),
    self-rename allowed, code required non-blank.
  - `toCommandEntry(values, original?)` → keeps unknown keys the original carried, trims name,
    keeps code as typed (trim only for the blank check).
  - `upsertCommandEntry(entries, entry, originalName?)` → replaces the *shown* entry (duplicate-name
    shadowing resolved as `indexOfShown` in `replConfigEdit.ts` does: first parseable entry under
    the name, else first carrying it), appends when no match.
  - `findCommandEntry(entries, name)` / `removeCommandEntry(entries, name)` — remove drops every
    entry with the name; unrelated and even invalid entries survive all operations untouched.

- [x] **Step 2: Run tests to verify they fail**
  Run: `make test`
  Expected: FAIL — functions missing.

- [x] **Step 3: Implement the edit rules**
  Same file. Do **not** import from `replConfigEdit.ts` — parallel implementation, per the design.

- [x] **Step 4: Run tests to verify they pass**
  Run: `make test`
  Expected: PASS.

- [x] **Step 5: Commit**
  `git commit -m "feat: form-edit rules for custom REPL commands"`

### Task 3: Form panel

**Files:**
- Create: `src/repl/customCommandFormPanel.ts`
- Test: `src/test/customCommandFormPanel.test.ts`

- [x] **Step 1: Write failing tests**
  Mirror `replFormPanel.test.ts` with a fake panel host: open add → posts load with empty values;
  open edit → loads the entry's values; open reuses an existing panel (title updated, values
  re-posted); submit with errors re-posts errors and writes nothing; valid submit writes the
  upserted array and closes; write failure posts a `form` error and stays open (only when the form
  still shows the same state — the `owns` guard); delete asks for confirmation, writes removal,
  closes; cancel/dispose close the panel.

- [x] **Step 2: Run tests to verify they fail**
  Run: `make test`
  Expected: FAIL — module doesn't exist.

- [x] **Step 3: Implement the panel**
  Port `ReplFormPanel`'s structure: same deps shape (`createPanel`, `readEntries`, `writeEntries`,
  `confirmDelete` — no `defaultCommand`), same message protocol, same `owns` guard, same
  CSP/nonce HTML approach. Form body: Name input, Code textarea (`rows="5"`, editor font), hint
  "Runs in the active REPL. Use fully-qualified symbols, e.g. (user/reset).", Save/Cancel/Delete
  buttons identical in style. Titles: "Add REPL Command" / `Edit REPL Command: <name>`.

- [x] **Step 4: Run tests to verify they pass**
  Run: `make test`
  Expected: PASS.

- [x] **Step 5: Commit**
  `git commit -m "feat: custom REPL command form panel"`

> Deviation: codex review flagged that overlapping saves could derive from the same
> settings snapshot and silently drop one another's changes (last write wins). Added a
> serialized read-modify-write queue (`updateEntries`) to the panel plus a regression test —
> goes beyond the mirrored `ReplFormPanel`, which still carries the same latent race.
> A second round moved validation inside the queued section too, so an overlapping save
> that just lost its name to a predecessor reports the conflict instead of appending a
> shadowed duplicate. A third round disabled the webview's Save button while a submission
> is in flight, so a double-click cannot race itself into a false name conflict.

### Task 4: Tree provider

**Files:**
- Create: `src/repl/customCommandsTree.ts`
- Test: `src/test/customCommandsTree.test.ts`

- [x] **Step 1: Write failing tests**
  Provider takes `{ readCommands: () => CustomReplCommand[] }`. `getChildren()` → one node
  `{name}` per command, in settings order; `getTreeItem` maps `presentCustomCommand` onto a
  `vscode.TreeItem` with ThemeIcon `code` and a click command invoking
  `clojurePulse.editCustomReplCommand` with the node; `refresh()` fires
  `onDidChangeTreeData`. (Tests run under vscode-test, so importing `vscode` is fine —
  see `replTree.test.ts`.)

- [x] **Step 2: Run tests to verify they fail**
  Run: `make test`
  Expected: FAIL.

- [x] **Step 3: Implement the provider**
  Thin class, presentation delegated to the pure function (pattern: `ReplTreeProvider`).

- [x] **Step 4: Run tests to verify they pass**
  Run: `make test`
  Expected: PASS.

- [x] **Step 5: Commit**
  `git commit -m "feat: custom REPL commands tree provider"`

### Task 5: Command status bar

**Files:**
- Create: `src/repl/commandStatusBar.ts`
- Test: `src/test/commandStatusBar.test.ts`

- [x] **Step 1: Write failing tests**
  Mirror `testStatusBar.test.ts`'s structure for the simpler shape:
  - Pure presentation: running → `$(loading~spin) <name>`; success → `$(check) <name>` with
    color `testing.iconPassed` and the result value in the tooltip, truncated to its first
    line / 100 chars (also cover: no value at all — e.g. output-only commands — tooltip still
    reads sensibly); failure → `$(error) <name> — failed` with
    `backgroundColor: "statusBarItem.errorBackground"` and no `color`. Every state's `command`
    is `clojurePulse.showReplOutput`.
  - Item behavior via `current()`: `running()` returns a token and shows the spinner;
    `finish(token, run)` renders the verdict; a superseded token's `finish`/`clear` is a no-op;
    `clear(token)` hides the item.

- [x] **Step 2: Run tests to verify they fail**
  Run: `make test`
  Expected: FAIL — module doesn't exist.

- [x] **Step 3: Implement the module**
  Port `testStatusBar.ts`'s split: a pure `commandStatusBarPresentation(run)` over
  `{ phase: "running"; name } | { phase: "done"; name; status: "ok" | "err"; value?: string }`,
  and a `createCommandStatusBar()` factory with the same token-guarded
  `running`/`finish`/`clear`/`current`/`dispose` interface. Priority 97 (just right of the test
  item's 98), item name "Clojure Pulse Command". No count parsing — that is the test bar's
  concern.

- [x] **Step 4: Run tests to verify they pass**
  Run: `make test`
  Expected: PASS.

- [x] **Step 5: Commit**
  `git commit -m "feat: status bar feedback for custom REPL commands"`

### Task 6: package.json contributions

**Files:**
- Modify: `package.json`

- [x] **Step 1: Add the setting**
  `clojurePulse.customReplCommands`: array, default `[]`, `"scope": "resource"`, items requiring
  `name` + `code` (both strings, `additionalProperties: false`), a `markdownDescription` that
  includes the keybinding example
  `{ "key": "ctrl+alt+r", "command": "clojurePulse.runCustomReplCommand", "args": "reset" }`,
  and one defaultSnippet (`name: "reset"`, `code: "(user/reset)"`).

- [x] **Step 2: Add view, welcome, commands, menus**
  - View `clojurePulse.customCommands` ("REPL Commands") inserted **between** `replManager` and
    `externalLibraries` in the `views` array.
  - viewsWelcome: "No commands yet." + one line about keybindings + `[Add Command](command:clojurePulse.addCustomReplCommand)`.
  - Commands: run (`$(play)`), add (`$(add)`), edit (`$(edit)`), delete (`$(trash)`), all
    category "Clojure Pulse".
  - Menus: `view/title` add for the new view; `view/item/context` for
    `viewItem == customReplCommand`: run `inline@1`, run `1_run@1`, edit `2_config@1`,
    delete `2_config@2`.

- [x] **Step 3: Compile**
  Run: `make compile`
  Expected: clean.

- [x] **Step 4: Commit**
  `git commit -m "feat: contribute custom REPL commands view, setting, and commands"`

> Note: codex flagged the manifest-before-wiring state (contributed commands/view with
> no handlers) as P1; that is the plan's sequencing — Task 7 registers everything in the
> immediately following commit.

### Task 7: Extension wiring and integration test

**Files:**
- Modify: `src/extension.ts`
- Test: `src/test/customCommands.integration.test.ts`

- [x] **Step 1: Write failing integration test**
  Model on `replCommands.integration.test.ts` + `fakeNreplServer.ts`: configure a custom command
  in settings, connect a session, mark it active, execute `clojurePulse.runCustomReplCommand`
  with the name as arg, assert the fake server received the code as an eval op. Also cover: name
  that doesn't exist → no eval sent. Teardown must restore `clojurePulse.customReplCommands` to
  its prior value so state never leaks across tests.

- [x] **Step 2: Run test to verify it fails**
  Run: `make test`
  Expected: FAIL — command not registered.

- [x] **Step 3: Wire everything in `activate`'s REPL section**
  - Raw read/write helpers for `clojurePulse.customReplCommands` (pattern:
    `rawReplConfigurations` / `writeReplConfigurations`).
  - Instantiate the form panel (webview options and icon copied from the `replForm` block), the
    tree provider, and `createCommandStatusBar()`; register the view; push all of them into
    `context.subscriptions`.
  - Extend the existing `onDidChangeConfiguration` listener (or add a sibling) to `refresh()` the
    tree when `clojurePulse.customReplCommands` changes.
  - Register the four commands. Run: resolve name (string | `{name}` | quick-pick; empty settings
    on a bare invocation → `executeCommand("clojurePulse.addCustomReplCommand")`), look up the
    parsed command (unknown → error notification naming the setting), then `activeSession(registry)`
    (bail before any status bar change when it returns undefined) and the status bar lifecycle
    around `session.eval(code)`: `running(name)`, `finish` ok/err from the outcome's `err`, and
    `finish` err when the eval throws. No `showOutput()` — runs are silent per the design.
    Edit and Delete: accept a `{name}` tree node; invoked bare from the palette, quick-pick a
    command first (pattern: `editReplConfig` / `deleteReplConfig`). Delete then confirms with a
    modal (pattern: `confirmDeleteConfig`) and writes `removeCommandEntry`.
  - Log parse warnings to `outputChannel` on read (pattern: `applyReplConfigs`).

- [x] **Step 4: Run tests to verify they pass**
  Run: `make test`
  Expected: PASS, including all earlier suites.

- [x] **Step 5: Commit**
  `git commit -m "feat: run, add, edit, and delete custom REPL commands"`

### Task 8: Docs and final check

**Files:**
- Modify: `README.md`

- [x] **Step 1: Document the feature**
  Short section: what custom commands are, the pane (click to edit, play to run), the setting
  shape, and the keybinding example. Use /writing-clearly.

- [x] **Step 2: Full gate**
  Run: `make check`
  Expected: lint, compile, and tests all pass.

- [x] **Step 3: Commit**
  `git commit -m "docs: custom REPL commands"`

> Deviation (Task 7, recorded here): `commandStatusBar` was added to the `ExtensionApi`
> returned by `activate()` so the integration tests can assert the run verdict — mirrors
> how `testStatusBar` is already exposed.

---

## Completion Summary (2026-08-06)

**Status: completed.** All 8 tasks done; `make check` passes (lint, compile, 559 tests);
the .vsix packages cleanly. Every task commit passed a codex second-opinion review.

What was built: the `clojurePulse.customReplCommands` setting (resource scope), the pure
rules module `customCommands.ts`, the editor-tab form `customCommandFormPanel.ts`, the
sidebar pane `customCommandsTree.ts` (between REPL and External Libraries; click = edit,
play = run), the silent run pipeline with `commandStatusBar.ts` verdicts, four commands
(run/add/edit/delete) with quick-pick fallbacks, manifest contributions, integration tests
against the fake nREPL server, and a README section with the keybinding recipe.

Deviations (all recorded inline under their tasks):
- Form panel hardening beyond the mirrored `ReplFormPanel`, driven by three codex review
  rounds: serialized settings writes, validation inside the queued section, and a Save
  button disabled while a submission is in flight. `ReplFormPanel` still carries the same
  latent write race — worth a follow-up port of the same queue.
- Task 6's manifest-before-wiring state was flagged P1 by codex; resolved by Task 7's
  commit as sequenced.
- `commandStatusBar` exposed on `ExtensionApi` for integration assertions.

What the plan could have specified better: it said to port `ReplFormPanel`'s structure
verbatim; specifying serialized read-modify-write for settings up front would have saved
two review rounds. Otherwise it held up — every file, identifier, and flow landed as
written.
