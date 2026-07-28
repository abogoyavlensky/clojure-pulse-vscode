# REPL Manager Implementation Plan

> **For agentic workers:** Use executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a REPL manager view to the sidebar that stores named REPL configurations in workspace settings, can spawn an nREPL server from a plain-text command (no deps.edn alias required) or connect to a running one, streams each REPL into its own syntax-highlighted Output channel (replacing the webview REPL panel), and supports multiple simultaneous REPLs with one active eval target.

**Tech Stack:** TypeScript (VS Code extension: TreeDataProvider, OutputChannel, child_process), nREPL (existing bencode client).

---

## Design

### Approach

A new **REPL view** joins the existing `clojurePulseSidebar` activity-bar container (retitled "Clojure Pulse"). It lists named REPL configurations stored in `clojurePulse.replConfigurations` (workspace settings — shareable, hand-editable, fully visible). Two config types:

- **`create`** — the extension spawns an nREPL server from a plain-text command line, discovers the port from stdout, and connects. The command string is the source of truth: what the pane shows is literally what runs. No alias detection; the add flow always prefills a predefined command that injects nREPL via `-Sdeps` under our own namespaced alias, and the user edits the text to add their own aliases.
- **`connect`** — attach to an already-running server at `host:port`, where `port` is a number or a workspace-relative path to a file containing the port (e.g. `".nrepl-port"`).

Each REPL gets its own **built-in Output channel** created with the `clojure` language id (syntax highlighting, cursor navigation, search for free). This **replaces the webview REPL panel entirely** — `replPanel.ts` and the `clojurePulseRepl` panel container are deleted. Multiple REPLs can run at once; evals route to the single **active** session.

`ConnectionManager` is untouched — it already models one connection's lifecycle. A `ReplSession` composes config + optional process + `ConnectionManager` + `Transcript` + output channel; a `ReplRegistry` owns all sessions and the active pointer.

### Config schema (shared contract)

```json
"clojurePulse.replConfigurations": [
  { "name": "dev", "type": "create",
    "command": "clojure -Sdeps '{:aliases {:clojure-pulse/nrepl {:extra-deps {nrepl/nrepl {:mvn/version \"1.7.0\"}} :main-opts [\"-m\" \"nrepl.cmdline\"]}}}' -M:clojure-pulse/nrepl",
    "cwd": "." },
  { "name": "staging", "type": "connect", "host": "localhost", "port": 7888 },
  { "name": "local", "type": "connect", "port": ".nrepl-port" }
]
```

- `name` — required, unique (validation rejects duplicates; invalid entries are skipped with a logged warning, never crash the tree).
- `type` — `"create"` | `"connect"`.
- `create`: `command` required; `cwd` optional, workspace-relative, defaults to the workspace root.
- `connect`: `host` optional (default `"localhost"`); `port` required, **number or string** — a number must be an integer in 1–65535; a string is a workspace-relative path to a file whose contents are the port (absolute paths are used as-is; empty strings are invalid; port-file contents are validated to the same 1–65535 range).

### Default create command (per platform)

POSIX (single source of truth in `defaultCreateCommand()`):

```
clojure -Sdeps '{:aliases {:clojure-pulse/nrepl {:extra-deps {nrepl/nrepl {:mvn/version "1.7.0"}} :main-opts ["-m" "nrepl.cmdline"]}}}' -M:clojure-pulse/nrepl
```

- Injecting an **alias** (not bare `:deps`) composes with user aliases: editing to `-M:dev:test:clojure-pulse/nrepl` merges `:extra-deps` from all three, and `:main-opts` is last-alias-wins, so nREPL always starts.
- The namespaced alias `:clojure-pulse/nrepl` cannot collide with project aliases.
- No `--interactive` — the extension owns the process; the bare server prints the port line and blocks.
- win32 variant swaps the outer single quotes for double quotes with `\"` inner escaping (best-effort; POSIX is the primary target, and the function seam makes fixes cheap).

### Process runner

`child_process.spawn(command, { shell: true, cwd, detached: process.platform !== "win32" })`. Stdout/stderr stream to the session's output channel. Port discovery: regex `nREPL server started on port (\d+)` on stdout, with a `.nrepl-port` file read (in `cwd`) as fallback checked on each output event **and on a 2s interval timer** (a server can write the file after its last output line); the timer stops on discovery, exit, or stop. **No startup timeout** — first runs may download deps for minutes; the channel shows progress and Stop is always available. Stop kills the whole process group (negative-PID `kill` on POSIX; `taskkill /T` on Windows) so the `clj`-wrapper→`java` tree dies. All processes are killed on deactivate.

### Output channel rendering

The `Transcript` class stays as the tested data model; a renderer subscribes and appends to the channel. Formatting keeps Clojure highlighting intact:

- `banner` / `info` → each line prefixed `;; `, trailing newline
- `in` → raw text, trailing newline
- `value` → `=> ` prefix, trailing newline
- `out` / `err` → appended raw (chunks carry their own newlines)

One channel per config, `REPL: <name>`, created lazily on first start/connect, kept across disconnects (history stays readable), disposed on config delete.

### Sessions and registry

- `ReplSession` states: `stopped` → `starting` (process spawned, awaiting port; create-type only) → `connecting` → `connected`. Any failure returns to `stopped`, with the reason in the channel and an error notification. **Invariant: entering `stopped` always kills an owned process** — this covers connect/handshake failure after the port appeared, connection loss mid-session, and explicit Stop, so a create-type session can never report `stopped` while its server lives.
- `ReplRegistry` derives sessions from configs, reacts to settings changes (add new, stop+remove deleted; a *running* session keeps the config it launched with, with the updated config stored as pending and applied when the session next reaches `stopped` — same mechanism updates stopped sessions immediately), owns the **active** session, and re-emits state changes for the tree and status bar. Connecting a session makes it active. It also hosts **ad-hoc** sessions (unsaved `connect` from the legacy prompt flow, named `host:port`).
- **Channels are registry-owned**, memoized by session name (the channel factory caches), so applying a pending config or replacing a stopped session preserves the channel and its history; channels are disposed only on config delete and extension disposal. The channel-sink interface is `append` / `clear` / `show` / `dispose`.

### Commands (single entry points for tree buttons, palette, and keybindings)

- `clojurePulse.startRepl` (`name?: string`) — brings a config up: spawn+connect for `create`, connect for `connect`. No arg → quick-pick over all configs (the palette path). Keybindings can pass `"args": "dev"` to bind a key to one config.
- `clojurePulse.stopRepl` (`name?`) — stops/disconnects; no arg → quick-pick over running sessions.
- `clojurePulse.connectRepl` (`name?`) — reworked: with a name, connects that config; without, quick-pick of `connect` configs plus an "Ad-hoc host:port…" entry (the current prompt flow, as an unsaved session).
- `clojurePulse.disconnectRepl` — disconnects the active session.
- `clojurePulse.addReplConfig` — quick-pick flow (type → name → prefilled command, or host/port with a `.nrepl-port` option) writing to workspace settings.
- `clojurePulse.setActiveRepl` (`name?`) — switches the eval target.
- `clojurePulse.showReplOutput` (`name?`) — reveals the session's channel, creating it if the session has never run (also the tree item's click action).
- `clojurePulse.editReplConfig` (`name?`) / `clojurePulse.deleteReplConfig` (`name?`) — the tree context actions, declared in `contributes.commands` like the rest.
- Eval commands (`evalSelection`, `evalCurrentForm`, `evalFile`) route to the registry's active session; inline results unchanged.

**Argument convention:** every `name?`-taking command accepts `string | ReplTreeNode | undefined` — tree menus pass the tree node (extract the session name from it), keybindings pass a string, the palette passes nothing (→ quick-pick fallback, for `setActiveRepl`/`showReplOutput`/`editReplConfig`/`deleteReplConfig` too). One shared `resolveSessionName(arg)` helper.

### Tree view UX

One node per configuration: label `name`, description shows state (`stopped` / `starting` / `connecting` / `connected :7888`), active session marked with a distinct icon. Context values drive inline actions: Start/Stop (create), Connect/Disconnect (connect), Set Active, Edit (opens workspace settings.json), Delete. View title has `+` (add config). Empty state via `viewsWelcome` points at the add command. The status bar item shows the active session (name + host:port) and its menu gains "Switch active REPL" listing connected sessions.

### Error handling

- Malformed config entries: skipped, warning in the "Clojure Pulse" log channel, tree renders valid ones.
- Spawn failure / process exit before port discovery: session → `stopped`, exit code and last output in the channel, one error notification.
- Port file missing/invalid on connect: clear error naming the resolved file path.
- Connection loss: existing `ConnectionManager` path; session → `stopped`, tree/status bar update; if it was active, active becomes undefined (eval commands then warn with a Start/Connect action).

### Testing strategy

Project pattern: pure presentation/parsing functions with unit tests, `vscode` wiring kept thin. Unit tests: config validation, default command per platform, port-line parsing, port-file resolution, transcript→channel formatting, registry active/lifecycle logic, tree presentation, status bar presentation. Process runner tested against real short-lived shell commands (`echo`/`sleep`). Integration tests (existing `fakeNreplServer`): update `replCommands.integration` for the panel removal; new test with two simultaneous fake servers verifying per-session transcripts and active-session eval routing.

---

## File Structure

**Create:**
- `src/repl/replConfig.ts` — config types, settings read + validation, `defaultCreateCommand()`, `resolvePort()` (number passthrough or port-file read; generalizes `readNreplPort`).
- `src/repl/outputRenderer.ts` — pure `formatEntry(entry): string` + renderer binding a `Transcript` to an injected channel-like sink.
- `src/repl/replProcess.ts` — pure `parseNreplPort(line): number | undefined` + `ReplProcess` (spawn, output events, port discovery, group kill).
- `src/repl/replSession.ts` — session state machine composing config, process, `ConnectionManager`, transcript, channel.
- `src/repl/replRegistry.ts` — sessions from configs, settings-change sync, active session, aggregate events, dispose-all.
- `src/repl/replTree.ts` — pure `presentSession()` + `ReplTreeProvider implements vscode.TreeDataProvider`.
- `src/test/replConfig.test.ts`, `src/test/outputRenderer.test.ts`, `src/test/replProcess.test.ts`, `src/test/replSession.test.ts`, `src/test/replRegistry.test.ts`, `src/test/replTree.test.ts`.

**Modify:**
- `package.json` — setting schema, new view + container retitle, remove panel container/webview view, commands, menus, viewsWelcome.
- `src/extension.ts` — `setupRepl` rework: registry, tree, commands; eval routing via active session.
- `src/repl/replStatusBar.ts` — presentation gains session name / no-active state.
- `src/repl/connectionManager.ts` — only extract/reuse of port-file reading (`readNreplPort` moves to `replConfig.ts` or is re-exported).
- `src/test/replStatusBar.test.ts`, `src/test/replCommands.integration.test.ts`, `src/test/connectionManager.test.ts` (import path if `readNreplPort` moves).
- `README.md`, `CHANGELOG.md` — feature docs.

**Delete:**
- `src/repl/replPanel.ts` (webview panel), its `package.json` contributions.

---

### Task 1: Config model (`replConfig.ts`)

**Files:**
- Create: `src/repl/replConfig.ts`, `src/test/replConfig.test.ts`
- Modify: `src/repl/connectionManager.ts` (move `readNreplPort` into `replConfig.ts`; re-export or update imports), `src/test/connectionManager.test.ts`, `src/extension.ts` (import path)

- [x] **Step 1: Write failing tests**
  Cover: `parseReplConfigurations(raw: unknown)` → `{ configs, warnings }` — accepts valid create/connect entries, fills `host` default `localhost` and `cwd` default `"."`, rejects (with warning strings) entries missing `name`/`command`/`port`, wrong `type`, duplicate names, non-object items; `defaultCreateCommand(platform)` — POSIX string matches the design's command exactly, win32 uses double quotes with `\"` escaping, both contain `:clojure-pulse/nrepl` and `nrepl.cmdline` and no `--interactive`; `resolvePortSync(port, workspaceRoot)` — number passthrough, string reads the file (reuse `readNreplPort` logic generalized to a full path), missing/garbage file → undefined.

- [x] **Step 2: Run tests to verify they fail**
  Run: `npm test`
  Expected: FAIL — new suite cannot resolve `../repl/replConfig`.

- [x] **Step 3: Implement**
  Types: `ReplConfig = CreateReplConfig | ConnectReplConfig`; `CreateReplConfig { name; type: "create"; command; cwd }`; `ConnectReplConfig { name; type: "connect"; host; port: number | string }`. Pure module, no `vscode` import (settings raw value is passed in). Move `readNreplPort` here as `readPortFile(filePath)`; keep a thin re-export in `connectionManager.ts` if that avoids churn.

- [x] **Step 4: Run tests to verify they pass**
  Run: `npm test`
  Expected: PASS (including existing connectionManager tests).

- [x] **Step 5: Commit**
  `git commit -m "Add REPL configuration model with validation and default create command"`

> Deviation: `readNreplPort` moved out of `connectionManager.ts` entirely (no re-export) — `replConfig.ts` exports both `readPortFile(fullPath)` and `readNreplPort(dir)`, and the `readNreplPort` test suite moved to `replConfig.test.ts` so tests sit with the code.
> Deviation: added `resolvePortFilePath(port, workspaceRoot)` so connect errors can name the port file they failed to read (the design calls for that error message).
> Deviation (codex review, fixup `f09c207`): port-file contents are now matched against `^\d+$` before parsing — `parseInt` accepted `7888abc` as 7888.

### Task 2: Output channel renderer (`outputRenderer.ts`)

**Files:**
- Create: `src/repl/outputRenderer.ts`, `src/test/outputRenderer.test.ts`

- [x] **Step 1: Write failing tests**
  `formatEntry(entry): string` per the design's formatting rules (banner/info `;; ` per line + newline; in raw + newline; value `=> ` + newline; out/err raw). Renderer test with a fake sink `{ append(text) }`: replays existing transcript entries on attach, mirrors subsequent appends, `clear()` on transcript clear.

- [x] **Step 2: Run tests to verify they fail**
  Run: `npm test` — FAIL.

- [x] **Step 3: Implement**
  `attachTranscriptRenderer(transcript, sink)` where `sink` is a minimal structural interface (`append`, `clear`) satisfied by `vscode.OutputChannel`. Pure module, no `vscode` import.

- [x] **Step 4: Run tests to verify they pass**
  Run: `npm test` — PASS.

- [x] **Step 5: Commit**
  `git commit -m "Add transcript-to-output-channel renderer"`

### Task 3: Process runner (`replProcess.ts`)

**Files:**
- Create: `src/repl/replProcess.ts`, `src/test/replProcess.test.ts`

- [x] **Step 1: Write failing tests**
  `parseNreplPort(text)` — matches `nREPL server started on port 55123`, ignores other lines, first match wins across chunk boundaries (feed accumulated text). `ReplProcess` against real shell commands: `start()` with `echo "nREPL server started on port 12345" && sleep 30` resolves `waitForPort()` with 12345; a command exiting without a port line rejects `waitForPort()` with the exit code in the message; `stop()` terminates a `sleep 30` promptly and fires `onExit`; output events carry stdout and stderr text. Guard the shell-command tests with a POSIX platform check (skip on win32), and stop any started process in `afterEach` so a failing assertion never leaks a `sleep`.

- [x] **Step 2: Run tests to verify they fail**
  Run: `npm test` — FAIL.

- [x] **Step 3: Implement**
  Spawn per the design (shell, cwd, detached on POSIX). Buffer stdout for port parsing; `waitForPort()` also polls `readPortFile(cwd + "/.nrepl-port")` on each output event as fallback (only accept the file if its mtime is newer than `start()` time, so a stale file from a previous run is not picked up). Group kill: POSIX `process.kill(-pid, "SIGTERM")` then SIGKILL after a short grace; win32 `taskkill /PID <pid> /T /F`. No `vscode` import.

- [x] **Step 4: Run tests to verify they pass**
  Run: `npm test` — PASS.

- [x] **Step 5: Commit**
  `git commit -m "Add nREPL process runner with port discovery and group kill"`

> Deviation: `ReplProcess` also handles the child's `close` event (a failed spawn emits `error`+`close`, never `exit`), so the port poller is always released, and the poll timer is `unref()`ed.
> Deviation (codex review, fixups `7fd9365`/`6ee9085`/`c6ae07c`): `stop()` kills the process *group* rather than trusting the shell's exit code — a command that daemonizes nREPL leaves the server alive in the group — while never signalling a group id that could have been recycled. Ownership after the shell exits comes from a sample taken in the exit handler; the `kill` seam in `ReplProcessOptions` exists so tests can assert which signals are sent.

### Task 4: Session (`replSession.ts`)

**Files:**
- Create: `src/repl/replSession.ts`, `src/test/replSession.test.ts`

- [x] **Step 1: Write failing tests**
  Use `fakeNreplServer` and an injected fake process factory + fake channel sink. Cover: connect-type session `start()` → `connecting` → `connected`, banner lands in its transcript; create-type session runs process, on port resolution connects, states pass `starting` → `connecting` → `connected`; process exit before port → `stopped` with error surfaced as transcript `info`/`err`; `stop()` from `connected` disconnects (and kills process for create-type) → `stopped`; **create-type: connect failure after port discovery kills the process, and connection loss while `connected` kills the process** (the `stopped`-kills-owned-process invariant); port-file connect config resolves via `resolvePortSync`; state-change events fire in order.

- [x] **Step 2: Run tests to verify they fail**
  Run: `npm test` — FAIL.

- [x] **Step 3: Implement**
  `ReplSession` owns: config, own `Transcript` + renderer attached to a lazily-created channel (factory injected: `(name) => sink`), own `ConnectionManager`, optional `ReplProcess` (factory injected). Public: `name`, `state`, `connectionInfo`, `start()`, `stop()`, `eval()`/`loadFile()` delegating to its ConnectionManager, `onDidChangeState`, `dispose()`. Session state derives from process phase + ConnectionManager state.

- [x] **Step 4: Run tests to verify they pass**
  Run: `npm test` — PASS.

- [x] **Step 5: Commit**
  `git commit -m "Add REPL session composing process, connection, and output channel"`

> Deviation: the injected channel factory is `createChannel(name)` on a `ReplSessionDeps` object (alongside `createProcess` and `workspaceRoot`), and the session exposes `showOutput()` so the reveal command works before a session has ever run.
> Deviation (codex review, fixups `2 rounds`): startups are cancelled by an explicit `stop()`/`dispose()` via an attempt counter, so a port arriving mid-shutdown cannot reconnect; `stopped` is published only after the kill resolves; and a kill that *fails* keeps the session out of `stopped` and rejects, so a restart cannot double-spawn a server.

### Task 5: Registry (`replRegistry.ts`)

**Files:**
- Create: `src/repl/replRegistry.ts`, `src/test/replRegistry.test.ts`

- [x] **Step 1: Write failing tests**
  Cover: `setConfigs()` creates sessions per valid config; removing a config stops and disposes its session (and its channel); updating a *stopped* session's config applies immediately **and keeps the same channel (memoized factory — history survives)**; updating a *running* one stores the config as pending, keeps the launched config while running, and applies the pending config when the session reaches `stopped`; connecting/starting a session sets it active; `active` cleared when the active session stops; `addAdHoc(host, port)` yields a transient session named `host:port` that disappears on disconnect; aggregate `onDidChange` fires on any session state change; `dispose()` stops everything.

- [x] **Step 2: Run tests to verify they fail**
  Run: `npm test` — FAIL.

- [x] **Step 3: Implement**
  Constructor takes a session factory so tests inject fakes. Public: `sessions`, `get(name)`, `active`, `setActive(name)`, `setConfigs(configs)`, `addAdHoc(info)`, `onDidChange`, `dispose()`.

- [x] **Step 4: Run tests to verify they pass**
  Run: `npm test` — PASS.

- [x] **Step 5: Commit**
  `git commit -m "Add REPL registry with active-session routing"`

> Deviation: the registry owns the channel factory (`createChannel`) and hands sessions a memoized `channelFor(name)`; the session factory is `createSession(config, channelFor)`. `setConfigs` returns a promise so callers can await removals actually shutting down. A running session's edit is applied by *replacing* the session object (same channel), not by mutating it.
> Deviation (codex review, 3 rounds): `setActive` only accepts a *connected* session; saving a configuration over an ad-hoc name promotes that session; a retired session whose server would not die is kept in an `undead` set (keyed by object, so a re-added name cannot shadow it) and killed again by `dispose()`; and a session that could not kill its process refuses to `start()` again, which is what keeps a failed stop from double-spawning a server.

### Task 6: Tree view and status bar presentation

**Files:**
- Create: `src/repl/replTree.ts`, `src/test/replTree.test.ts`
- Modify: `src/repl/replStatusBar.ts`, `src/test/replStatusBar.test.ts`

- [x] **Step 1: Write failing tests**
  `presentSession(session, isActive)` → `{ label, description, icon, contextValue }`: description per state (`stopped`, `starting`, `connecting`, `connected :7888`); contextValues `replCreateStopped` / `replCreateRunning` / `replConnectStopped` / `replConnectConnected` / `replAdHoc` (drive which inline actions show); active session gets the highlighted icon (`vscode-testing-run-icon`-style: use `circle-filled` vs `circle-outline`). Status bar: presentation takes the active session (name + info) and a no-active-but-sessions-exist state pointing at `clojurePulse.startRepl`.

- [x] **Step 2: Run tests to verify they fail**
  Run: `npm test` — FAIL.

- [x] **Step 3: Implement**
  `ReplTreeProvider` (flat list, refresh on registry `onDidChange`), item click command `clojurePulse.showReplOutput` with the session name as arg. Update `replStatusPresentation` signature; keep it pure.

- [x] **Step 4: Run tests to verify they pass**
  Run: `npm test` — PASS.

- [x] **Step 5: Commit**
  `git commit -m "Add REPL tree presentation and multi-session status bar"`

> Deviation: `presentSession(session, { isActive, isAdHoc })` — ad-hoc-ness comes from the registry, not the session, so it is passed alongside `isActive`. Items also carry a tooltip (the command line, or `host:port` / the port file). Icons: `debug-disconnect` when stopped, `loading~spin` while coming up, `circle-outline`/`circle-filled` for connected/active.
> Deviation: the status bar takes `{ active?, busy, total }` rather than a single state. With nothing configured it points at `clojurePulse.connectRepl` (which offers the ad-hoc flow) instead of `addReplConfig` — that keeps the item working in this commit, where the manager commands are not registered yet, and remains the more useful action for someone with a REPL already running.

### Task 7: Wiring — commands, package.json, webview removal

**Files:**
- Modify: `package.json`, `src/extension.ts`, `src/test/replCommands.integration.test.ts`
- Delete: `src/repl/replPanel.ts`

- [ ] **Step 1: package.json contributions**
  Add: `clojurePulse.replConfigurations` setting (full JSON schema with per-type required fields and markdown descriptions, including the default create command in the docs); `clojurePulse.replManager` view (name "REPL") **above** External Libraries in `clojurePulseSidebar`; retitle the container "Clojure Pulse"; commands `startRepl`, `stopRepl`, `addReplConfig`, `setActiveRepl`, `showReplOutput`, `editReplConfig`, `deleteReplConfig` (keep `connectRepl`/`disconnectRepl`); `view/title` `+` menu and `view/item/context` inline menus keyed on the Task 6 contextValues; `viewsWelcome` for the empty REPL view ("No REPL configurations yet — Add one"). Remove: `clojurePulseRepl` panel container and the `clojurePulse.replView` webview view. Update the `clojurePulse.inlineEvalResults` setting description — it still says results "appear only in the REPL pane"; it should point at the `REPL: <name>` output channels.

- [ ] **Step 2: Rework `setupRepl` in extension.ts**
  Instantiate registry (real session factory: `vscode.window.createOutputChannel("REPL: " + name, "clojure")`), feed it parsed configs, re-parse on `onDidChangeConfiguration`, log validation warnings to the existing output channel. Register commands per the design, all through the shared `resolveSessionName(arg)` helper (string from keybindings, tree node from menus, quick-pick when absent): `startRepl(name?)` (works for both types), `stopRepl(name?)`, reworked `connectRepl(name?)` with the ad-hoc entry, `addReplConfig` flow writing via `config.update("replConfigurations", ..., ConfigurationTarget.Workspace)`, `setActiveRepl`, `showReplOutput`, `deleteReplConfig` (confirms first), `editReplConfig` (runs `workbench.action.openWorkspaceSettingsFile`). Route eval commands and `replMenu` through `registry.active` (menu gains "Switch active REPL"); `ensureConnected` warns with Start/Connect when no active session. Delete `replPanel.ts` and all `panel.reveal()` uses (evals reveal nothing; inline results or the channel carry the output; `evalFile`/`evalSelection` call `showReplOutput` for the active session where the panel was revealed before). Shutdown must be awaitable so the SIGTERM grace period and Windows `taskkill` actually run: `registry.dispose()` returns a promise, and `deactivate()` awaits it (keep a module-level registry reference, like the existing `client` pattern) — `context.subscriptions` alone fires and forgets.

- [ ] **Step 3: Update integration tests**
  `replCommands.integration.test.ts`: replace panel expectations with registry/active-session assertions; keep eval command coverage green via `ExtensionApi` (expose the registry alongside `replManager` — keep `replManager` pointing at the active session's ConnectionManager or update tests accordingly, whichever keeps the API honest).

- [ ] **Step 4: Compile, lint, full test run**
  Run: `npm test`
  Expected: PASS; no references to `replPanel` remain (`grep -r replPanel src` is empty).

- [ ] **Step 5: Manual smoke test**
  In the extension host (F5): add a `create` config in a deps.edn project, Start from the tree button, watch the channel stream startup output, confirm auto-connect and `evalCurrentForm`; add a `connect` config with `"port": ".nrepl-port"`; run two REPLs, switch active via status bar, confirm eval routing; Stop kills the java process (`ps` check); reload window — no orphaned processes.

- [ ] **Step 6: Commit**
  `git commit -m "Add REPL manager view with create/connect configs and per-REPL output channels"`

### Task 8: Multi-session integration test

**Files:**
- Modify: `src/test/replCommands.integration.test.ts` (or a new `replManager.integration.test.ts`)

- [ ] **Step 1: Write the test**
  Two `fakeNreplServer` instances; configure two `connect` configs via the settings API; `startRepl("a")`, `startRepl("b")` → both connected, `b` active; `evalSelection` reaches only server `b`; `setActiveRepl("a")` reroutes to `a`; disconnecting `a` clears active and eval warns instead of throwing; `startRepl` with a bogus name shows an error, not a crash (covers the keybinding-args path).

- [ ] **Step 2: Run and fix until green**
  Run: `npm test`
  Expected: PASS.

- [ ] **Step 3: Commit**
  `git commit -m "Add multi-session REPL integration coverage"`

### Task 9: Documentation

**Files:**
- Modify: `README.md`, `CHANGELOG.md`

- [ ] **Step 1: Write the docs** (use /writing-clearly)
  README gains a "REPL manager" section: the two config types with the full settings example from the design; the default create command shown verbatim with a short explanation of the `-Sdeps` alias injection and how to add your own aliases (`-M:dev:test:clojure-pulse/nrepl`); the `.nrepl-port` string-port mode; running a config from the tree, the palette, and a keybinding with `"args": "dev"` (include the keybindings.json snippet); multiple REPLs and the active session; note that REPL output lives in the Output panel under `REPL: <name>`. CHANGELOG entry summarizing the feature and the webview panel removal.

- [ ] **Step 2: Commit**
  `git commit -m "Document REPL manager configuration and usage"`
