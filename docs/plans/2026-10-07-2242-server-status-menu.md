# Server Status Bar Menu Implementation Plan

> **For agentic workers:** Use executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clicking the `clj-pulse` status-bar item opens a quick pick that restarts the language server or shows its output, mirroring the nREPL item's menu.

**Tech Stack:** TypeScript, VS Code extension API, Mocha through `@vscode/test-cli`.

---

## Design

### Problem

The `clj-pulse` status-bar item (`src/statusBar.ts`, `createStatusBar`) is
hard-wired to `clojurePulse.showOutput`. Restarting the server means opening
the Command Palette and finding **Clojure Pulse: Restart Language Server**.
The nREPL item next to it already opens a quick pick of actions
(`replMenu` in `src/extension.ts`), so users expect the server item to do
the same.

### Behaviour

Clicking the item runs a new hidden command `clojurePulse.serverMenu`, which
shows a `vscode.window.showQuickPick` with two entries, in this order:

| Label | Action |
|---|---|
| `$(output) Show server output` | `outputChannel.show()` (same as `clojurePulse.showOutput`) |
| `$(debug-restart) Restart language server` or `$(debug-start) Start language server` | `restart()` (same as `clojurePulse.restart`) |

The second label reads **Start** when the last status is `stopped` or
`error`, and **Restart** otherwise. Both run the existing `restart()`, which
is `stop()` then `start()` and already tolerates a missing or dead client.
Output stays first: it is the safe, read-only action and what the item did
before, so a reflexive click still lands on something harmless.

The placeholder is `Language server actions — <state>`, where `<state>` is
`starting`, `running`, `stopped`, or `error`, so the pick reads as a
status line the way the REPL menu's `active: <name>` does.

Escape dismisses the pick and does nothing.

The two palette commands `clojurePulse.restart` and `clojurePulse.showOutput`
stay as they are. The menu command is contributed in `package.json` with
`"when": "false"` under `menus.commandPalette`, exactly like
`clojurePulse.replMenu`, so it never appears in the palette.

### Tooltips

Every state's tooltip ends in a click hint today: `click to view output`
on `stopped` and `error`, none on `starting` and `running`. All four now end
in `— click for actions`, matching the REPL item's `click for REPL actions`.
The running tooltip keeps its version, command, and lint lines; the hint
goes on the first line so the multi-line detail is unchanged.

### Where the pieces live

- **`src/statusBar.ts`** gains a pure, exported `serverMenuItems(status)`
  returning the two quick-pick items plus the placeholder, so the label
  logic (Start vs Restart) is unit-tested without VS Code, the way
  `statusPresentation` and `replStatusPresentation` are. `createStatusBar`
  sets `item.command = "clojurePulse.serverMenu"` and remembers the last
  status it painted, exposed as a `status` getter on the `StatusBar`
  interface so `extension.ts` need not keep a parallel variable.

  Shape both tasks must agree on:

  ```ts
  export type ServerMenuAction = "show" | "restart";

  export interface ServerMenuItem extends vscode.QuickPickItem {
    action: ServerMenuAction;
  }

  export interface ServerMenu {
    items: ServerMenuItem[];
    placeHolder: string;
  }

  export function serverMenuItems(status: ServerStatus): ServerMenu;

  export interface StatusBar {
    /** The last status painted; "stopped" before the first update. */
    readonly status: ServerStatus;
    update(status: ServerStatus, detail?: StatusDetail): void;
    dispose(): void;
  }
  ```

  `QuickPickItem` is a plain interface, so importing the type keeps the
  function free of runtime `vscode` calls and the test can run it directly.

- **`src/extension.ts`** registers `clojurePulse.serverMenu` next to the
  other two server commands and adds a small `serverMenu()` function beside
  `replMenu` that calls `serverMenuItems(statusBar.status)`, shows the pick,
  and dispatches on `action`.

- **`package.json`** contributes the command (title `Language Server Menu`,
  category `Clojure Pulse`) and hides it from the palette.

- **`src/test/manifest.test.ts`** already asserts the palette shows exactly
  the `PALETTE` list and that hidden commands are hidden; the new command
  joins the hidden set it derives from `menus.commandPalette`, so the
  existing tests cover the manifest change once the hidden entry is in
  place. No edit to `PALETTE`.

### Testing

Unit tests in `src/test/statusBar.test.ts`:
- `serverMenuItems("running")` returns show then restart, restart labelled
  `Restart language server`.
- `serverMenuItems("stopped")` and `("error")` label it `Start language server`.
- `serverMenuItems("starting")` labels it `Restart language server`.
- The placeholder names the status.
- Every `statusPresentation` tooltip ends with `click for actions`.

`src/test/extension.test.ts` gains one assertion in "registers its
commands" that `clojurePulse.serverMenu` is registered. The quick pick itself
is not driven in tests (no existing test drives `replMenu` either); it is
verified by hand.

### Docs

- `docs/troubleshooting.md`, "Language server does not start": the status
  item now opens a menu, so say "Click the **clj-pulse** status item and
  choose **Show server output**" and mention **Restart language server** is
  in the same menu.
- `docs/reference.md`: no new row, the menu command is hidden. Leave the two
  palette rows as they are.
- `docs/features.md` "Language intelligence and dependencies": no change
  needed unless a sentence there describes clicking the item; there is none.

## File Structure

- Modify: `src/statusBar.ts` — `serverMenuItems`, `status` getter, new click command, tooltip hints.
- Modify: `src/test/statusBar.test.ts` — unit tests for the menu and tooltips.
- Modify: `src/extension.ts` — `serverMenu()` and its command registration.
- Modify: `package.json` — contribute and hide `clojurePulse.serverMenu`.
- Modify: `src/test/extension.test.ts` — assert the command is registered.
- Modify: `docs/troubleshooting.md` — describe the menu.

## Tasks

### Task 1: Menu items and tooltips in `statusBar.ts`

**Files:**
- Modify: `src/statusBar.ts`
- Test: `src/test/statusBar.test.ts`

- [ ] **Step 1: Write the failing tests**
  Add `suite("serverMenuItems", ...)` to `src/test/statusBar.test.ts` with
  the five cases from the design (running, starting, stopped, error,
  placeholder). Assert on `items[i].action` and `items[i].label`. In the
  `statusPresentation` suite add one test looping over all four statuses
  asserting `view.tooltip` matches `/click for actions$/m`, and one for
  `running` with `serverInfo`, `command`, and `lint` set asserting the hint
  is on the first line (`tooltip.split("\n")[0]` ends with it) and the
  command and lint lines follow unchanged.

- [ ] **Step 2: Run the tests to verify they fail**
  Run: `npm run compile-tests` then `make test`
  Expected: compile fails because `serverMenuItems` is not exported.

- [ ] **Step 3: Implement**
  In `src/statusBar.ts` add the types and `serverMenuItems` from the design
  after `statusPresentation`. Append `— click for actions` to every
  tooltip's first line in `statusPresentation` (replace the two existing
  `— click to view output` suffixes). In `createStatusBar` keep a
  `let status: ServerStatus = "stopped"` updated in `update()` and expose it
  via a `get status()` on the returned object. Leave `item.command` on
  `clojurePulse.showOutput` for now: it switches to the menu in Task 2,
  in the same commit that registers the command, so no commit leaves the
  item pointing at an unregistered command.

- [ ] **Step 4: Run the tests to verify they pass**
  Run: `make test`
  Expected: PASS, including the new suite.

- [ ] **Step 5: Lint**
  Run: `npm run lint`
  Expected: no errors.

- [ ] **Step 6: Commit**
  `git commit -m "Describe the server status-bar menu as pure data"`

### Task 2: Wire the menu command

**Files:**
- Modify: `src/extension.ts`
- Modify: `package.json`
- Modify: `src/test/extension.test.ts`

- [ ] **Step 1: Contribute the command**
  In `package.json` add `clojurePulse.serverMenu` (title `Language Server
  Menu`, category `Clojure Pulse`) to `contributes.commands` right after
  `clojurePulse.showOutput`, and a `{"command": "clojurePulse.serverMenu", "when": "false"}`
  entry in `menus.commandPalette` next to the `replMenu` one.

- [ ] **Step 2: Assert registration**
  In `src/test/extension.test.ts` "registers its commands", add an assertion
  that `clojurePulse.serverMenu` is registered, in the same style as the
  `showOutput` one.

- [ ] **Step 3: Run the tests to verify the new assertion fails**
  Run: `make test`
  Expected: the manifest tests pass; "registers its commands" fails on
  `clojurePulse.serverMenu`.

- [ ] **Step 4: Implement `serverMenu`**
  In `src/statusBar.ts` `createStatusBar`, set
  `item.command = "clojurePulse.serverMenu"` and update its doc comment to
  say clicking opens the server menu. In `src/extension.ts` import `serverMenuItems` from `./statusBar`. Add
  `async function serverMenu(): Promise<void>` next to `replMenu`: build
  `serverMenuItems(statusBar?.status ?? "stopped")`, call
  `vscode.window.showQuickPick(items, { placeHolder })`, then `switch` on
  `choice?.action`: `show` → `outputChannel?.show()`, `restart` → `await restart()`.
  Register `vscode.commands.registerCommand("clojurePulse.serverMenu", serverMenu)`
  beside the `restart` and `showOutput` registrations.

- [ ] **Step 5: Type-check, lint, test**
  Run: `make check`
  Expected: lint clean, compile clean, all tests pass.

- [ ] **Step 6: Verify in the editor**
  Run: `make package && make install-extension`, reload the window, open a
  Clojure file. Click the `clj-pulse` item.
  Expected: a quick pick with **Show server output** and **Restart language
  server**, placeholder `Language server actions — running`. Choose restart:
  the item spins, then returns to the pulse icon, and the output channel
  shows a new `starting server` line. Click again, choose show output: the
  channel opens. Set `clojurePulse.server.path` to a bogus path and restart:
  the item turns red, and its menu now offers **Start language server**.
  If no editor is available, drive the same through `vscode-test` as the
  log-server-version plan did and note the deviation.

- [ ] **Step 7: Commit**
  `git commit -m "Open a restart/output menu from the clj-pulse status item"`

### Task 3: Docs

**Files:**
- Modify: `docs/troubleshooting.md`

- [ ] **Step 1: Describe the menu**
  In "Language server does not start", change the first paragraph to say the
  **clj-pulse** status item opens a menu with **Show server output** and
  **Restart language server** (**Start language server** once the server is
  stopped or in error), and that the palette commands still work.
  Keep the hover sentence. Use /writing-clearly.

- [ ] **Step 2: Commit**
  `git commit -m "Docs: the clj-pulse status item opens a menu"`
