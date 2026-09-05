# Minimize Command Palette Implementation Plan

**Status: completed** (2026-09-05, commits a4ca01d..5d005ed)

> **For agentic workers:** Use executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut the Clojure Pulse command palette from 30 entries to 20 by removing redundant commands, unlisting keybinding-only commands, and hiding sidebar-only commands, without losing any reachable behaviour.

**Tech Stack:** VS Code extension manifest (`package.json` contributes), TypeScript, Mocha via `@vscode/test-cli`.

---

## Design

### Why

Every Clojure Pulse command shows in the palette, including ones that only
make sense as a keybinding (Insert Newline and Indent), ones that duplicate a
sidebar button (Delete REPL Configuration), and ones the REPL lifecycle
already covers (Connect to Running nREPL). Typing "Clojure" in the palette
gives 30 hits. The user-facing set after this plan is 20, and every removed
entry stays reachable the way people actually use it.

### Three mechanisms

1. **Remove entirely** (contribution, registration, handler):
   `clojurePulse.connectRepl`, `clojurePulse.disconnectRepl`,
   `clojurePulse.evalSelection`.
   - Start, Stop and Restart REPL become the single set of verbs for both
     `create` and `connect` configurations. The lifecycle code is already
     type-agnostic: `startRepl` picks on `state === "stopped"` with no type
     check and `session.start()` on a connect config connects; `stopRepl`
     picks on `state !== "stopped"` so it disconnects connected sessions.
     This mirrors VS Code's own "Start Debugging", which covers both `launch`
     and `attach` configurations.
   - Evaluate Current Form already prefers a non-empty selection
     (`evalCurrentForm`, "A non-empty selection wins"), so Evaluate Selection
     is a strict subset. The merged path also sends the file's `ns`, which
     Evaluate Selection skipped.
2. **Unlist from `contributes.commands` but keep registered and keybound**:
   `clojurePulse.newline` (Enter) and `clojurePulse.clearInlineResults`
   (Escape). A `keybindings` contribution may name a command that is not in
   `commands`; both still show in the Keyboard Shortcuts editor through their
   default bindings, and users can still rebind by ID.
3. **Hide with `menus.commandPalette` `"when": "false"`, keep contributed**:
   `clojurePulse.replMenu` (status-bar click handler), `deleteReplConfig` and
   `deleteCustomReplCommand` (the Edit form has a Delete button),
   `addProject` (view title button; its sibling `editProject` is already
   hidden), `selectCurrentForm` (keybinding target with no default binding;
   staying contributed keeps its title searchable in the Keyboard Shortcuts
   editor). This is the mechanism `enableProjectClasspath` and friends already
   use.

`editReplConfig` and `editCustomReplCommand` stay visible on purpose: without
an argument each opens a picker, which is a real shortcut over finding the row
in the sidebar.

### Renames

- "Restart Server" becomes "Restart Language Server".
- "Show Output" becomes "Show Language Server Output".

"Server" stopped being unambiguous once Stop REPL started killing nREPL
servers. The second rename makes the entry sit naturally next to "Show REPL
Output".

### Retargets for the removed connect command

Everything that pointed at `clojurePulse.connectRepl` points at
`clojurePulse.startRepl`, which already opens the add form when nothing is
configured:

- `package.json` `view/item/context` inline button for
  `viewItem == replConnectStopped`. The row gets the play icon; accepted.
- `src/repl/replStatusBar.ts` zero-configurations branch. Tooltip becomes
  "Clojure Pulse: no REPL configured — click to add one".
- `activeSession` in `src/extension.ts`: the "No REPL is connected" warning
  always offers a single "Start REPL" action. The `startable` branch and the
  "Connect" choice go.

The Start REPL picker description for a stopped `connect` configuration reads
`connect · host:port` from its config (`ConnectReplConfig.host` and `.port`,
where `port` may be a file path such as `.nrepl-port` and is shown as
written). Running sessions and `create` configurations keep the current
`describeSession` text. This keeps the generic verb honest about what will
happen.

### Palette after the change (20)

| Group | Commands |
|---|---|
| Server | Restart Language Server, Show Language Server Output |
| REPL | Start REPL, Stop REPL, Restart REPL, Add REPL Configuration, Edit REPL Configuration, Set Active REPL, Show REPL Output |
| Eval | Evaluate Current Form, Evaluate File, Copy Evaluation Result |
| Tests | Run Test at Cursor, Run Tests in Namespace, Run Last Test Command |
| Custom | Run Custom REPL Command, Add Custom REPL Command, Edit Custom REPL Command |
| Other | Refresh External Libraries, Show ClojureDocs (Clojure editors only) |

### Testing

- Existing integration tests that used the removed commands move to their
  replacements: `evalCurrentForm` with a selection, `stopRepl` with a name.
- The registration test asserts the removed IDs are absent.
- A new unit test reads `package.json` and asserts the set of palette-visible
  commands equals the explicit list above. It pins the outcome and catches
  silent regrowth. "Visible" means: listed in `contributes.commands` and not
  hidden by a `commandPalette` entry with `"when": "false"`.

### Deferred

A `clojurePulse.active` context key so non-Clojure workspaces show none of
these commands goes to the backlog, not this plan.

## File Structure

Modified:

- `package.json`: remove three commands, unlist two, hide five, rename two,
  retarget one menu entry.
- `src/extension.ts`: delete `connectRepl`, `disconnectRepl`, `evalSelection`
  handlers and their registrations, the `ConnectPick` interface, and the
  Connect branch of `activeSession`; extend `describeSession` for stopped
  connect configs.
- `src/repl/replStatusBar.ts`: zero-configurations branch targets
  `startRepl`.
- `src/test/replCommands.integration.test.ts`: registration list, three
  eval-selection tests, the disconnect test.
- `src/test/replManager.integration.test.ts`: `selectAndEval` helper.
- `src/test/replStatusBar.test.ts`: zero-configurations case.
- `README.md`: Commands section, "Running them" paragraph, Evaluate Selection
  bullet, inline-results bullet.

Created:

- `src/test/manifest.test.ts`: palette-visible command set.
- `docs/backlog/palette-activation-gate.md`: deferred activation gate.

Test command for the whole suite: `make test` (uses xvfb on Linux). Lint and
type-check: `make lint` and `make compile`. When piping output through
`tail` or `grep`, read the summary line rather than the pipeline's exit code,
which only reflects the last command. `npm test` runs `pretest`, which
compiles and lints first, so a failing lint shows up before any test runs.

## Tasks

### Task 1: Remove Connect and Disconnect, retarget to Start REPL

**Files:**
- Modify: `src/extension.ts`
- Modify: `src/repl/replStatusBar.ts`
- Modify: `package.json`
- Test: `src/test/replCommands.integration.test.ts`
- Test: `src/test/replStatusBar.test.ts`

- [x] **Step 1: Update the tests first**
  In `src/test/replCommands.integration.test.ts`:
  - In "registers the REPL commands", remove `clojurePulse.connectRepl` and
    `clojurePulse.disconnectRepl` from the present list. Add a second loop
    after it asserting `!commands.includes(id)` for
    `["clojurePulse.connectRepl", "clojurePulse.disconnectRepl"]` with the
    message `` `command ${id} should be gone` ``.
  - In "disconnecting stops the REPL and clears the eval target", replace
    `executeCommand("clojurePulse.disconnectRepl")` with
    `executeCommand("clojurePulse.stopRepl", session.name)`. Rename the test
    to "stopping a connected REPL clears the eval target".

  In `src/test/replStatusBar.test.ts`, "no configurations at all": rename to
  "no configurations at all: offers to add one", assert `view.command` is
  `clojurePulse.startRepl`, and assert the tooltip matches `/add/i`.

- [x] **Step 2: Run the two test files to see them fail**
  Run: `make test 2>&1 | grep -E "passing|failing|✗|[0-9]+\)" | head -20`
  Expected: failures in "registers the REPL commands" (connectRepl still
  registered) and the replStatusBar zero-config case.

- [x] **Step 3: Remove the handlers and registrations in `src/extension.ts`**
  - Delete the `registerCommand` calls for `clojurePulse.connectRepl` and
    `clojurePulse.disconnectRepl`.
  - Delete `async function connectRepl` and the `ConnectPick` interface above
    it.
  - In `activeSession`, replace the `startable`/`action` logic with a single
    "Start REPL" action: show the warning with that one button and call
    `startRepl(registry)` when chosen. Update the comment above it: with
    nothing configured, Start REPL opens the add form itself.
  - Keep `stopSession` and `runSessionStart`; they still serve the remaining
    verbs and the status-bar menu.

- [x] **Step 4: Retarget the status bar**
  In `src/repl/replStatusBar.ts`, the `total === 0` branch: command
  `clojurePulse.startRepl`, tooltip
  `"Clojure Pulse: no REPL configured — click to add one"`. Rewrite the
  comment: Start REPL opens the add form when nothing is configured.

- [x] **Step 5: Retarget the tree button in `package.json`**
  In `contributes.menus["view/item/context"]`, change the entry with
  `viewItem == replConnectStopped` from `clojurePulse.connectRepl` to
  `clojurePulse.startRepl`. Remove the `clojurePulse.connectRepl` and
  `clojurePulse.disconnectRepl` objects from `contributes.commands`.

- [x] **Step 6: Extend `describeSession` for stopped connect configs**
  In `src/extension.ts`, when `session.state === "stopped"` and
  `session.config.type === "connect"`, return
  `` `connect · ${config.host}:${config.port}` ``. Every other case keeps the
  existing text. Add a one-line doc comment saying why: Start REPL covers
  both config types, so the picker row says which it is.

- [x] **Step 7: Grep for leftovers**
  Run: `grep -rn "connectRepl\|disconnectRepl\|ConnectPick" src package.json README.md`
  Expected: only the absence assertions in
  `src/test/replCommands.integration.test.ts` and README hits (fixed in
  Task 4).

- [x] **Step 8: Lint, compile, test**
  Run: `make check 2>&1 | tail -15`
  Expected: lint and compile clean, all tests passing.

- [x] **Step 9: Commit**
  `git commit -am "Fold Connect and Disconnect into Start and Stop REPL"`

### Task 2: Remove Evaluate Selection

**Files:**
- Modify: `src/extension.ts`
- Modify: `package.json`
- Test: `src/test/replCommands.integration.test.ts`
- Test: `src/test/replManager.integration.test.ts`

- [x] **Step 1: Move the tests to Evaluate Current Form**
  In `src/test/replCommands.integration.test.ts`:
  - Remove `clojurePulse.evalSelection` from the present list in "registers
    the REPL commands" and add it to the absent list from Task 1.
  - Delete "evalSelection without a connection warns instead of throwing";
    its `evalCurrentForm` twin directly below already covers it.
  - "connect + evalSelection round-trips through a running nREPL": rename to
    "connect + evaluating a selection round-trips through a running nREPL"
    and execute `clojurePulse.evalCurrentForm`. The selection set on the
    editor stays; the assertions stay.
  - "the setting none primes nothing on connect": execute
    `clojurePulse.evalCurrentForm`.

  In `src/test/replManager.integration.test.ts`, `selectAndEval`: execute
  `clojurePulse.evalCurrentForm`.

- [x] **Step 2: Run to see the registration test fail**
  Run: `make test 2>&1 | grep -E "passing|failing|[0-9]+\)" | head -10`
  Expected: "registers the REPL commands" fails because
  `clojurePulse.evalSelection` is still registered; the moved eval tests pass
  already.

- [x] **Step 3: Remove the command**
  - `src/extension.ts`: delete the `clojurePulse.evalSelection` registration
    and `async function evalSelection`.
  - `package.json`: delete the `clojurePulse.evalSelection` object from
    `contributes.commands`.

- [x] **Step 4: Grep for leftovers**
  Run: `grep -rn "evalSelection\|Evaluate Selection" src package.json README.md`
  Expected: only the absence assertion in
  `src/test/replCommands.integration.test.ts` and README hits (fixed in
  Task 4).

- [x] **Step 5: Lint, compile, test**
  Run: `make check 2>&1 | tail -15`
  Expected: clean.

- [x] **Step 6: Commit**
  `git commit -am "Remove Evaluate Selection; Evaluate Current Form already covers it"`

### Task 3: Unlist, hide, rename, and pin the palette set

**Files:**
- Modify: `package.json`
- Create: `src/test/manifest.test.ts`

- [x] **Step 1: Write the manifest test**
  Create `src/test/manifest.test.ts` (plain Mocha `suite`/`test`, no `vscode`
  import). Resolve `package.json` from the compiled test's location the way
  `src/test/grammar.test.ts` resolves the grammar file, then compute the
  palette-visible set:
  - start from every `command` in `contributes.commands`;
  - drop any whose `contributes.menus.commandPalette` entry has
    `when === "false"`.

  Assert with `assert.deepStrictEqual` that the sorted result equals this
  sorted list:

  ```
  clojurePulse.restart
  clojurePulse.showOutput
  clojurePulse.startRepl
  clojurePulse.stopRepl
  clojurePulse.restartRepl
  clojurePulse.addReplConfig
  clojurePulse.editReplConfig
  clojurePulse.setActiveRepl
  clojurePulse.showReplOutput
  clojurePulse.evalCurrentForm
  clojurePulse.evalFile
  clojurePulse.copyEvalResult
  clojurePulse.runTestAtCursor
  clojurePulse.runNsTests
  clojurePulse.rerunLastTest
  clojurePulse.runCustomReplCommand
  clojurePulse.addCustomReplCommand
  clojurePulse.editCustomReplCommand
  clojurePulse.refreshExternalLibraries
  clojurePulse.showClojureDocs
  ```

  Add a second test asserting the two keybinding-only commands are still
  bound: `contributes.keybindings` contains entries for
  `clojurePulse.newline` and `clojurePulse.clearInlineResults`, and neither
  appears in `contributes.commands`.

  Add a third test asserting the titles of `clojurePulse.restart` and
  `clojurePulse.showOutput` are "Restart Language Server" and "Show Language
  Server Output".

- [x] **Step 2: Run to see it fail**
  Run: `make test 2>&1 | grep -E "manifest|passing|failing" | head -10`
  Expected: all three manifest tests fail against the current manifest.

- [x] **Step 3: Edit `package.json`**
  - Remove the `clojurePulse.newline` and `clojurePulse.clearInlineResults`
    objects from `contributes.commands`. Leave `contributes.keybindings`
    untouched.
  - Append to `contributes.menus.commandPalette` a `"when": "false"` entry
    for each of `clojurePulse.replMenu`, `clojurePulse.deleteReplConfig`,
    `clojurePulse.deleteCustomReplCommand`, `clojurePulse.addProject`,
    `clojurePulse.selectCurrentForm`, in the same shape as the existing
    `enableProjectClasspath` entry.
  - Retitle `clojurePulse.restart` to "Restart Language Server" and
    `clojurePulse.showOutput` to "Show Language Server Output".

- [x] **Step 4: Confirm the runtime registrations are untouched**
  Run: `grep -n '"clojurePulse.newline"\|"clojurePulse.clearInlineResults"' src/extension.ts`
  Expected: both `registerCommand` lines still present.

- [x] **Step 5: Lint, compile, test**
  Run: `make check 2>&1 | tail -15`
  Expected: clean, including `newline.integration.test.ts`, which executes
  the command by ID.

- [x] **Step 6: Commit**
  `git add src/test/manifest.test.ts package.json && git commit -m "Trim the command palette to the commands users reach for by name"`

### Task 4: Update the README

**Files:**
- Modify: `README.md`

- [x] **Step 1: "Running them" paragraph (around line 432)**
  Replace the sentence naming **Start REPL**, **Stop REPL**, **Connect to
  Running nREPL** so it names **Start REPL** and **Stop REPL** only, and add
  one sentence saying the same commands serve both `create` and `connect`
  configurations: starting a `connect` entry attaches to the running server,
  stopping it disconnects.

- [x] **Step 2: Evaluate Selection bullet (around line 491)**
  Delete the **Evaluate Selection** bullet. In the Evaluate Current Form
  bullet nearby, make sure the selection behaviour is stated: with a
  non-empty selection, exactly the selected code is sent.

- [x] **Step 3: Inline results bullet (around line 559)**
  Remove "**Clear Inline Results** removes them all, and" so the sentence
  reads that Escape hides the results and **Copy Evaluation Result** copies
  the value at the cursor.

- [x] **Step 4: Commands section (around line 660)**
  Rewrite the list to match the 20 visible commands, in the table order from
  the Design section. Rename the first two entries. Drop Connect, Disconnect,
  Evaluate Selection, Clear Inline Results, Delete REPL Configuration, Delete
  Custom REPL Command, Copy is kept. Add a closing paragraph, in
  /writing-clearly style, listing what is reachable but not in the palette
  and where to find it: Enter and Escape bindings (`clojurePulse.newline`,
  `clojurePulse.clearInlineResults`), Select Current Form
  (`clojurePulse.selectCurrentForm`, bind it in Keyboard Shortcuts), the
  delete actions (the Edit form's Delete button and the row's context menu),
  Add Project (the External Libraries view title), the status-bar REPL menu.

- [x] **Step 5: Check no stale names remain**
  Run: `grep -n "Connect to Running\|Disconnect from nREPL\|Evaluate Selection\|Clear Inline Results\|Restart Server\|\*\*Show Output\*\*" README.md`
  Expected: no output.

- [x] **Step 6: Commit**
  `git commit -am "Document the trimmed command palette"`

### Task 5: Backlog the activation gate

**Files:**
- Create: `docs/backlog/palette-activation-gate.md`

- [x] **Step 1: Write the backlog entry**
  Follow the shape of `docs/backlog/def-prefixed-call-highlighted-as-definition.md`:
  a title line, `**Status: open**`, then Problem, Proposed fix, Origin.
  - Problem: `contributes.commands` are static, so every Clojure Pulse
    command shows in the palette of a workspace with no Clojure at all.
  - Proposed fix: at activation call `setContext` with
    `clojurePulse.active = true` (the extension already sets a context key in
    `src/repl/inlineResults.ts`), then add `"when": "clojurePulse.active"` to
    every palette-visible command in `menus.commandPalette`. An unset context
    key evaluates false, so before activation nothing shows. Note the
    interaction with `showClojureDocs`, which already has an `editorLangId`
    condition, and that the manifest test from
    `src/test/manifest.test.ts` will need its visibility rule extended.
  - Origin: deferred from the command palette trim
    (`docs/plans/2026-09-05-1445-minimize-command-palette.md`).

- [x] **Step 2: Commit**
  `git add docs/backlog/palette-activation-gate.md && git commit -m "Backlog: gate palette commands on extension activation"`

### Task 6: Final verification

- [x] **Step 1: Full check**
  Run: `make check 2>&1 | tail -15`
  Expected: lint and compile clean, all tests passing.

- [x] **Step 2: Package and inspect the manifest**
  Run: `npx vsce ls --tree 2>/dev/null | head -5; node -e "const c=require('./package.json').contributes; const hidden=new Set(c.menus.commandPalette.filter(m=>m.when==='false').map(m=>m.command)); console.log(c.commands.filter(x=>!hidden.has(x.command)).length)"`
  Expected: the count prints `20`.

## Completion summary

Implemented as planned, in five commits plus this document. The palette went
from 30 entries to 20:

- `a4ca01d` folded Connect and Disconnect into Start and Stop REPL and
  retargeted the tree button, status bar, and no-connection warning.
- `ce6bd8c` removed Evaluate Selection; its tests moved to Evaluate Current
  Form with a selection.
- `d2ffa8a` unlisted the two keybinding-only commands, hid five sidebar-only
  commands, renamed the two language-server commands, and added
  `src/test/manifest.test.ts` pinning the visible set.
- `bfe9f5f` updated the README; `5d005ed` added the activation-gate backlog
  entry.

Verification: `make check` passes (822 tests). A packaged VSIX ships 28
contributed commands, 8 hidden, 20 visible, with both Enter and Escape
keybindings intact and the connect row's button pointing at Start REPL. Each
task commit had a clean Codex review.

Deviations: none. Session task tracking (TaskCreate) was unavailable, so this
document was the only progress record.

What the plan could have specified better: nothing.
