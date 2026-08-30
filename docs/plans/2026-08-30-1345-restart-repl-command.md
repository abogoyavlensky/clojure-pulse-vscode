# Restart REPL Command Implementation Plan

> **For agentic workers:** Use executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `Clojure Pulse: Restart REPL` command that stops a REPL and starts it again, applying any configuration edit made while it was running.

**Tech Stack:** TypeScript, VS Code extension API (commands, `view/item/context` menus, quick picks), Mocha via `vscode-test` against the in-repo fake nREPL server.

---

## Design

### Problem

Restarting a REPL today takes two commands (Stop REPL, Start REPL) and two round trips through the tree or the palette. Worse, the natural moment to restart — right after editing a REPL's configuration — is exactly when the two-step dance is easiest to get wrong: the registry holds an edited configuration as *pending* until the session stops, and the user has no single action that says "take the new settings and come back up".

### Approach

One new command, `clojurePulse.restartRepl`, that stops a session and starts it again through the registry. No changes to `ReplSession` or `ReplRegistry`: their existing `stop → pending replace → start` machinery already does the work. The command's only real job is to resolve *which* session and to start the *right object* afterwards.

### Target resolution

The command resolves its target exactly like the other REPL commands (`startRepl`, `stopRepl`, `setActiveRepl`), via the existing `sessionFor` / `resolveSessionName` / `pickSession` helpers in `src/extension.ts`:

1. **A name argument** — from a keybinding (`"args": "dev"`) or a tree row — names the session. An unknown name gets the standard `no REPL named "…"` error from `sessionFor`, not a quick pick.
2. **No argument, an active session** — the active session is restarted.
3. **No argument, no active session** — quick pick over sessions whose state is not `stopped`, placeholder `Restart a REPL`; with none, the info message `No REPL is running.`

### Decisions

- **Re-fetch the session by name after stopping.** After `session.stop()` resolves, the registry may have replaced the session object with one built from a pending configuration edit (`ReplRegistry.onSessionState` → `replace`). The command must call `registry.get(name)` again and start *that* session; starting the object it stopped would start the stale configuration. This is the one likely bug in the feature and it gets its own test.
- **Restarting a stopped REPL just starts it.** A named restart on a stopped session must not error: `stop()` is a no-op there, and starting is what the user meant. Only the argument-less quick pick is limited to running sessions, because "restart" reads oddly on a stopped row.
- **A failed stop aborts the restart.** If the owned process could not be killed, `stopSession` already reports it; the command then returns without calling `start()` (which would refuse anyway). One error, not two.
- **Existing helpers report errors.** `stopSession` for the stop, `runSessionStart` for the start — so failures show the same notifications (with the *Show Output* action) and `ConnectCancelledError` is swallowed as it is for Start REPL.
- **Active follows the restart on its own.** The registry makes a session active when it reaches `connected` (`onSessionState`), so the restarted REPL becomes the eval target again without extra code.
- **Surfaces:** Command Palette; the REPL row's right-click menu for running rows; and the status-bar REPL menu (`replMenu`) when there is an active REPL. **No inline row icon** — running rows already carry target / stop / edit, and a fourth icon crowds the row. **No default keybinding**, consistent with Start REPL and Stop REPL.

### Components

**`src/extension.ts`**

- `restartRepl(registry, arg?)`, placed after `stopSession`:
  ```ts
  async function restartRepl(registry: ReplRegistry, arg?: unknown): Promise<void>
  ```
  Resolves the session with `sessionFor(registry, arg, pick)` where `pick` returns `registry.active?.name` when there is an active session, otherwise `pickSession(registry, s => s.state !== "stopped", "Restart a REPL", "No REPL is running.")`. Then: remember `session.name`; `await session.stop()` inside the same try/catch shape as `stopSession` (or call `stopSession` and detect failure — see the note below); on failure return; re-fetch `registry.get(name)`; if it is gone (the configuration was removed while stopping) return silently; `await runSessionStart(fresh)`.

  Note on stop failure detection: `stopSession` swallows the error and returns `void`. Either make `stopSession` return a `boolean` (`true` when the stop succeeded) and use it from both `stopRepl` and `restartRepl`, or inline the try/catch in `restartRepl`. Prefer the boolean: one place reports stop failures.

- Register `clojurePulse.restartRepl` next to `clojurePulse.stopRepl` in `setupRepl`:
  ```ts
  vscode.commands.registerCommand("clojurePulse.restartRepl", (arg?: unknown) =>
    restartRepl(registry, arg),
  ),
  ```

- `replMenu`: add `{ label: "$(debug-restart) Restart", action: "restart" }` when `active` exists, listed just before *Disconnect*; the `restart` case calls `restartRepl(registry, active.name)`.

**`package.json`**

- `contributes.commands`: `clojurePulse.restartRepl`, title `Restart REPL`, category `Clojure Pulse`, icon `$(debug-restart)`. Place it right after `clojurePulse.stopRepl`.
- `contributes.menus["view/item/context"]`: a non-inline entry
  ```json
  {
    "command": "clojurePulse.restartRepl",
    "when": "view == clojurePulse.replManager && viewItem =~ /^(replCreateRunning|replConnectConnected)$/",
    "group": "0_run@1"
  }
  ```
  `0_run` sorts above the existing `1_output` and `2_config` groups, so *Restart REPL* is the first item in the right-click menu of a running row. The tree passes a `ReplTreeNode` (`{ name }`) as the argument, which `resolveSessionName` already understands.

**`README.md`**

- *Running them* (after the keybinding example, before the output-channel paragraph): one sentence that **Restart REPL** stops and starts a REPL in one go, and that this is how an edit made while a REPL is running takes effect. Mention it is on a running row's right-click menu and in the status-bar menu.
- *Commands* list: `**Clojure Pulse: Restart REPL** — stop a REPL and start it again, applying a configuration edited while it was running. Takes a name as its argument, like Start REPL.` Insert after *Stop REPL*.

**`CHANGELOG.md`**

- Under `## [Unreleased]`, a new bullet: **Restart REPL** — one command to stop a REPL and bring it back up, from the palette, a running row's right-click menu, or the status-bar REPL menu; a configuration edited while the REPL was running is applied on the way up.

### Error handling

Everything user-facing goes through the existing helpers: `sessionFor` for an unknown name, `stopSession`/`runSessionStart` for stop and start failures. The command never throws to VS Code. A configuration removed between stop and start makes the command end quietly — the REPL the user asked to restart no longer exists, and the registry already reported nothing for that in the stop/start commands either.

### Testing

Integration tests in `src/test/replManager.integration.test.ts` (the suite already runs two fake nREPL servers, `a` and `b`, and has `setConfigurations`, `waitUntil`, and `evals` helpers), plus one line in the registered-commands test in `src/test/replCommands.integration.test.ts`.

1. **Restart with no argument restarts the active REPL and nothing else.** Configure `a` and `b`, start `b` then `a` (so `a` is active). Run `clojurePulse.restartRepl` with no argument. Assert `a.socketCount() === 1` and `b.socketCount() === 1` both before and after, `api.repls.get("a")?.state === "connected"`, `api.repls.active?.name === "a"`, and that `a.received` gained a second `clone` (or `describe`) message — proof it reconnected — while `b.received` did not grow.
2. **Restart applies a configuration edited while running.** Configure `a` on port `a.port` and start it. The edit is held as *pending* inside the registry and is not observable through the session's `config` (which still shows `a.port`), so the test must wait for the configuration event to reach the registry some other way: subscribe with `api.repls.onDidChange(...)` **before** the edit, flip a flag when it fires, then `setConfigurations` with `a` on `b.port` and `waitUntil` the flag is set (`ReplRegistry.setConfigs` emits a change even when the edit is deferred). Then assert the running session still reports `state === "connected"` and `config.port === a.port` — proof the edit was deferred, not applied. Run `clojurePulse.restartRepl` with `"a"`. Assert `api.repls.get("a")?.connectionInfo?.port === b.port` and `api.repls.get("a")?.state === "connected"`.
3. **Restart of a stopped REPL starts it.** Configure `a`, do not start it; run `clojurePulse.restartRepl` with `"a"`; assert `state === "connected"`.
4. **Unknown name reports an error without throwing.** Add `clojurePulse.restartRepl` to the existing "starting an unknown REPL reports an error instead of throwing" test alongside the other commands, and assert the form did not open.
5. **Registered.** Add `"clojurePulse.restartRepl"` to the list in `registers the REPL commands`.

The full suite is run with `npm test` (which compiles, bundles, and lints first). To iterate on a single file, `npm run compile-tests && npx vscode-test --grep "REPL manager"` narrows the run.

## File Structure

- Modify: `src/extension.ts` — `restartRepl`, registration, `replMenu` entry, `stopSession` returning a boolean.
- Modify: `package.json` — command and context-menu contribution.
- Modify: `src/test/replManager.integration.test.ts` — restart tests.
- Modify: `src/test/replCommands.integration.test.ts` — registered-commands list.
- Modify: `README.md`, `CHANGELOG.md` — docs.

---

### Task 1: Command contribution and the failing tests

**Files:**
- Modify: `package.json`
- Modify: `src/test/replCommands.integration.test.ts`
- Modify: `src/test/replManager.integration.test.ts`

- [ ] **Step 1: Contribute the command in `package.json`**
  Add `clojurePulse.restartRepl` (title `Restart REPL`, category `Clojure Pulse`, icon `$(debug-restart)`) after `clojurePulse.stopRepl` in `contributes.commands`. Add the `view/item/context` entry from the design (group `0_run@1`, running rows only), placed before the `showReplOutput` context entry.

- [ ] **Step 2: Add the registered-command assertion**
  In `src/test/replCommands.integration.test.ts`, add `"clojurePulse.restartRepl"` to the id list in `registers the REPL commands`, after `"clojurePulse.stopRepl"`.

- [ ] **Step 3: Write the restart tests**
  In `src/test/replManager.integration.test.ts`, add the four tests from the design's *Testing* section (restart active with no argument; restart applies a pending edit; restart of a stopped REPL starts it; unknown name added to the existing error test). Keep them next to the existing stop/edit tests. Use `socketCount()` and `received` on the fake servers for the reconnect proof. In the pending-edit test, wait for the edit to reach the registry through an `api.repls.onDidChange` listener subscribed before the edit — the existing `waitUntil`-on-`config` pattern from the "edit while stopped" test cannot see a deferred edit.

- [ ] **Step 4: Run the tests to verify they fail**
  Run: `npm test`
  Expected: FAIL — the new restart tests fail because the command has no handler (`executeCommand` rejects with `command 'clojurePulse.restartRepl' not found`). `registers the REPL commands` may already pass: `getCommands()` can list a command contributed in `package.json` before a handler is registered, so do not rely on it as the red test. Everything else still passes.

- [ ] **Step 5: Commit**
  `git commit -m "Contribute Restart REPL and add its tests"`

### Task 2: Implement `restartRepl`

**Files:**
- Modify: `src/extension.ts`

- [ ] **Step 1: Make `stopSession` report success**
  Change `stopSession` to return `Promise<boolean>`: `true` when `session.stop()` resolved, `false` when it rejected (the error notification stays as is). Existing callers keep ignoring the result.

- [ ] **Step 2: Add `restartRepl`**
  After `stopSession`, add `restartRepl(registry, arg?)` following the design: resolve via `sessionFor` (active name first, then the running-only `pickSession`); `if (!(await stopSession(session))) return;`; `const fresh = registry.get(name); if (!fresh) return;`; `await runSessionStart(fresh);`. Add a doc comment explaining why the session is re-fetched by name (the registry may have swapped in a session built from a pending edit).

- [ ] **Step 3: Register the command and extend the status-bar menu**
  Register `clojurePulse.restartRepl` right after `clojurePulse.stopRepl` in `setupRepl`. In `replMenu`, add the `$(debug-restart) Restart` item (only when `active` exists, immediately before *Disconnect*) and its `restart` case calling `restartRepl(registry, active.name)`.

- [ ] **Step 4: Run the tests to verify they pass**
  Run: `npm test`
  Expected: PASS, including the four new restart tests and the registered-commands test. Lint is clean.

- [ ] **Step 5: Commit**
  `git commit -m "Add Restart REPL command"`

### Task 3: Documentation

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: README**
  In *Running them*, after the keybinding example, add the sentence about **Restart REPL** (stop and start in one go; how an edit made while running takes effect; available on a running row's right-click menu and in the status-bar menu). In the *Commands* list, add the *Restart REPL* entry after *Stop REPL*, using the wording from the design. Use /writing-clearly.

- [ ] **Step 2: CHANGELOG**
  Add the *Restart REPL* bullet under `## [Unreleased]`, above the bracket-highlighting bullet, using the wording from the design.

- [ ] **Step 3: Commit**
  `git commit -m "Document Restart REPL"`

### Task 4: Final verification

- [ ] **Step 1: Full test run**
  Run: `npm test`
  Expected: PASS across the whole suite.

- [ ] **Step 2: Manual check in the Extension Development Host** (only if a Clojure project with an nREPL is at hand)
  Start a `create` REPL, edit its command from the form while it is running, then right-click the row → *Restart REPL*. The output channel shows the process terminating, then `Running: <new command>`, and the row returns to `connected` with the filled (active) icon. The status-bar menu shows *Restart* while a REPL is active.

- [ ] **Step 3: Mark the plan complete**
  Add `**Status: completed** (YYYY-MM-DD)` under the title, as earlier plans do, and commit: `git commit -m "Mark the Restart REPL plan complete"`.
