# nREPL Connect + REPL Output Pane Implementation Plan

> **For agentic workers:** Use executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect to an already-running nREPL server, show REPL output in a Cursive-style webview pane in the bottom panel, evaluate the editor selection, and reflect connection state in the status bar.

**Tech Stack:** TypeScript, VS Code extension API (WebviewViewProvider, StatusBarItem), Node `net` sockets, bencode (hand-rolled, no new dependencies), mocha via `@vscode/test-cli`.

---

## Design

### Overview

The extension gets a self-contained nREPL client — independent of the clj-pulse language server. A connection manager owns one active connection and emits events; a webview view in the bottom panel (a "REPL" tab next to Terminal/Output, the same mechanism VS Code's Chat pane uses) renders the transcript; a second status bar item shows connection state.

### Key decisions

1. **Own nREPL client, zero new runtime deps.** A small bencode encode/decode module plus a **persistent socket** with request/response correlation by message `id`. (clojureVSCode opens a new TCP connection per message; we keep one socket, `clone` a session on connect, and route `out`/`err` to the pane.)
2. **Webview view in the panel area**, contributed via `contributes.viewsContainers.panel` + a `webview`-type view, rendered append-only from a transcript held in the extension host. `retainContextWhenHidden` stays off; the webview re-hydrates by requesting the full transcript on load. Styling uses `--vscode-*` theme variables so it looks native in light and dark themes.
3. **Connect UX:** prompt for host (default `localhost`) then port, pre-filled from the workspace `.nrepl-port` file when present. On success, `clone` a session, run `describe` and a version eval, and print a banner: `Connected to nREPL at localhost:7888 · nREPL 1.1.0 · Clojure 1.12.0`.
4. **Eval scope (MVP):** one command, `Evaluate Selection`, sends the selected text to the session and streams `value`/`out`/`err` entries into the pane. No namespace switching, no inline decorations yet.
5. **Status bar:** a separate item from the existing clj-pulse LSP item, following the same pure `statusPresentation` pattern as `src/statusBar.ts`. Disconnected: `$(debug-disconnect) nREPL`, click runs connect. Connected: `$(plug) nREPL localhost:7888`, click opens a quick-pick (Show REPL / Disconnect).
6. **Single active connection now, list-shaped data model** so a future sidebar with multiple connections and custom run configurations plugs in without a rewrite.

### Data flow

```
Connect command ──▶ ConnectionManager ──▶ NreplClient (socket, session)
                        │  events: status change, transcript entry
                        ├──▶ ReplPanel (webview) — renders transcript
                        └──▶ replStatusBar — renders status
Evaluate Selection ──▶ ConnectionManager.eval() ──▶ streams value/out/err back as transcript entries
```

Transcript entries are typed: `{ kind: "banner" | "in" | "value" | "out" | "err" | "info", text: string }`. The transcript is capped at 5000 entries (drop oldest).

### Error handling

- Connect failure (refused, timeout 5s, bad bencode): error notification, status stays disconnected, no partial state.
- Socket drop while connected: transcript gets an `info` entry, status flips to disconnected, no notification spam.
- Eval with no connection: warning notification offering to connect.
- All nREPL requests carry a unique `id`; responses with unknown ids are ignored (out-of-band `out`/`err` messages carrying the session id still go to the transcript).

### Testing strategy

- `bencode.ts`, `transcript.ts`, `replStatusBar.ts` presentation: pure unit tests.
- `NreplClient` and `ConnectionManager`: integration tests against a **fake nREPL server** (an in-test `net.createServer` speaking bencode) — covers clone/describe/eval, streamed partial responses, and socket drop.
- Command wiring: extension integration test asserting commands are registered and eval-with-no-connection warns instead of throwing.

## File Structure

```
src/
  nrepl/
    bencode.ts            # encode/decode over a streaming Buffer; pure
    client.ts             # NreplClient: persistent socket, id correlation, clone/describe/eval/close, out/err/close events
  repl/
    transcript.ts         # Transcript model: typed entries, cap, append/serialize; pure
    connectionManager.ts  # connect/disconnect/eval state machine, .nrepl-port discovery, event emitters
    replPanel.ts          # WebviewViewProvider: renders transcript, rehydrates on load
    replStatusBar.ts      # status bar item + pure presentation function
  test/
    bencode.test.ts
    nreplClient.test.ts   # uses fakeNreplServer helper
    fakeNreplServer.ts    # in-test bencode-speaking net server
    transcript.test.ts
    connectionManager.test.ts
    replStatusBar.test.ts
    replCommands.integration.test.ts
images/
  repl-icon.svg           # panel container icon (used if the view is dragged to a sidebar)
package.json              # commands, panel view container, webview view
src/extension.ts          # wiring
README.md, CHANGELOG.md   # docs
```

---

### Task 1: bencode module

**Files:**
- Create: `src/nrepl/bencode.ts`
- Test: `src/test/bencode.test.ts`

- [x] **Step 1: Write failing tests**
  Cover: encoding a flat message object (strings, ints, string arrays; keys with `undefined` values omitted); decoding integers, strings (byte-length aware — UTF-8 multibyte values), lists, and nested dicts; `decodeBuffer(buf)` returning `{ decoded: object[], rest: Buffer }` where a partial trailing message stays in `rest` untouched; decoding two concatenated messages in one buffer.

- [x] **Step 2: Run tests to verify they fail**
  Run: `make test`
  Expected: FAIL — `bencode.ts` does not exist.

- [x] **Step 3: Implement `bencode.ts`**
  `encode(value): Buffer` for strings/numbers/arrays/objects; `decodeBuffer(buf): { decoded: any[], rest: Buffer }` that decodes as many complete top-level values as available and returns the remainder. Byte-oriented (work on Buffers, not strings) so multibyte UTF-8 string lengths are correct. Reference: `bencodeUtil.ts` in the clojureVSCode repo, but typed and stream-safe.

- [x] **Step 4: Run tests to verify they pass**
  Run: `make test`
  Expected: PASS

- [x] **Step 5: Commit**
  `git commit -m "feat: add bencode encode/decode for nREPL"`

### Task 2: fake nREPL server test helper + NreplClient

**Files:**
- Create: `src/nrepl/client.ts`
- Create: `src/test/fakeNreplServer.ts`
- Test: `src/test/nreplClient.test.ts`

- [x] **Step 1: Write the fake server helper**
  `startFakeNrepl(): Promise<{ port, received: any[], respond(fn), close() }>` — a `net.createServer` that decodes incoming bencode messages and lets tests script responses per `op`. Default behaviors: `clone` → `{ "new-session": "sess-1", status: ["done"] }`; `describe` → versions map + `done`; `eval` → configurable multi-message sequence (e.g. `out` chunk, then `value`, then `done`).

- [x] **Step 2: Write failing NreplClient tests**
  Cover: `connect()` resolves and `clone()` returns a session id; `send()` correlates by `id` when responses arrive interleaved; `eval()` invokes an `onMessage` callback per partial message (out, value) and resolves on `done`; responses split across TCP chunks decode correctly (fake server writes a response in two `socket.write` calls); server socket close fires the client's `onClose` and pending requests reject.

- [x] **Step 3: Run tests to verify they fail**
  Run: `make test`
  Expected: FAIL — `client.ts` does not exist.

- [x] **Step 4: Implement `NreplClient`**
  `NreplClient.connect(host, port, timeoutMs)` → persistent `net.Socket`; outgoing messages get a monotonically increasing `id`; incoming data accumulates in a buffer through `decodeBuffer`; each decoded message dispatches to the pending request matching its `id` (a request completes when a message contains `status` including `"done"`); messages without a matching id go to a general `onUnhandled` callback. Public API: `clone()`, `describe()`, `eval(code, session, onMessage)`, `close()`, `onClose(cb)`.

- [x] **Step 5: Run tests to verify they pass**
  Run: `make test`
  Expected: PASS

- [x] **Step 6: Commit**
  `git commit -m "feat: add persistent nREPL client with id-correlated requests"`

### Task 3: transcript model

**Files:**
- Create: `src/repl/transcript.ts`
- Test: `src/test/transcript.test.ts`

- [x] **Step 1: Write failing tests**
  Cover: `append(entry)` stores typed entries and fires a listener; entries beyond the 5000 cap drop the oldest; `entries()` returns a snapshot; `clear()` empties and notifies.

- [x] **Step 2: Run tests to verify they fail**
  Run: `make test`
  Expected: FAIL

- [x] **Step 3: Implement `transcript.ts`**
  `TranscriptEntry = { kind: "banner" | "in" | "value" | "out" | "err" | "info"; text: string }`. Small class with `append`, `entries`, `clear`, `onDidAppend`, `onDidClear`. No vscode imports — keep it pure.

- [x] **Step 4: Run tests to verify they pass**
  Run: `make test`
  Expected: PASS

- [x] **Step 5: Commit**
  `git commit -m "feat: add REPL transcript model"`

### Task 4: connection manager

**Files:**
- Create: `src/repl/connectionManager.ts`
- Test: `src/test/connectionManager.test.ts`

- [x] **Step 1: Write failing tests**
  Using the fake nREPL server (real `NreplClient`): `connect({host, port})` moves state `disconnected → connecting → connected`, appends a banner entry containing host:port and versions from `describe`; connect to a closed port rejects and state returns to `disconnected`; `disconnect()` closes the socket and appends an `info` entry; server-side socket drop flips state to `disconnected` and appends an `info` entry; `eval("(+ 1 2)")` appends `in` then `value` entries; `readNreplPort(dir)` returns the number from a `.nrepl-port` file and `undefined` when absent (use a temp dir).

- [x] **Step 2: Run tests to verify they fail**
  Run: `make test`
  Expected: FAIL

- [x] **Step 3: Implement `connectionManager.ts`**
  Holds `NreplClient | undefined`, a `Transcript`, and `ReplState = "disconnected" | "connecting" | "connected"` with connection info. Exposes `connect(info)`, `disconnect()`, `eval(code)`, `state`, `onDidChangeState`, plus `readNreplPort(workspaceRoot)` as an exported pure helper. On connect: TCP connect (5s timeout) → `clone` → `describe` → eval `(clojure-version)` → banner. Wires client `onUnhandled` out/err messages for the active session into the transcript. `eval` streams each partial message into the transcript as it arrives (`out` → out entry, `err` → err entry, `value` → value entry). Design the internal shape as "list of connections with one active" (an array field, not a rewrite hook).

- [x] **Step 4: Run tests to verify they pass**
  Run: `make test`
  Expected: PASS

- [x] **Step 5: Commit**
  `git commit -m "feat: add REPL connection manager with .nrepl-port discovery"`

### Task 5: REPL status bar item

**Files:**
- Create: `src/repl/replStatusBar.ts`
- Test: `src/test/replStatusBar.test.ts`

- [x] **Step 1: Write failing tests**
  Mirror `src/test/statusBar.test.ts`: a pure `replStatusPresentation(state, info?)` returns text/tooltip/command — disconnected: `$(debug-disconnect) nREPL`, command `clojurePulse.connectRepl`; connecting: `$(loading~spin) nREPL`; connected: `$(plug) nREPL <host>:<port>`, command `clojurePulse.replMenu`.

- [x] **Step 2: Run tests to verify they fail**
  Run: `make test`
  Expected: FAIL

- [x] **Step 3: Implement `replStatusBar.ts`**
  Pure presentation function plus `createReplStatusBar()` factory (StatusBarItem, Left alignment, priority 99 so it sits next to the clj-pulse item) with `update(state, info)` and `dispose()` — same shape as `src/statusBar.ts`.

- [x] **Step 4: Run tests to verify they pass**
  Run: `make test`
  Expected: PASS

- [x] **Step 5: Commit**
  `git commit -m "feat: add nREPL connection status bar item"`

### Task 6: REPL webview panel

**Files:**
- Create: `src/repl/replPanel.ts`
- Create: `images/repl-icon.svg`
- Modify: `package.json`

- [x] **Step 1: Contribute the panel view in `package.json`**
  Add `contributes.viewsContainers.panel`: `[{ "id": "clojurePulseRepl", "title": "REPL", "icon": "images/repl-icon.svg" }]` and `contributes.views.clojurePulseRepl`: `[{ "type": "webview", "id": "clojurePulse.replView", "name": "REPL" }]`. Create a simple monochrome `repl-icon.svg` (e.g. a `λ` or prompt glyph, `currentColor` fill).

- [x] **Step 2: Implement `replPanel.ts`**
  `ReplPanelProvider implements vscode.WebviewViewProvider`, registered for `clojurePulse.replView`. The webview HTML is a self-contained string: a scrolling log `<div>`, CSS on `--vscode-editor-font-family` / `--vscode-terminal-ansi*` theme variables (values in editor foreground, `err` in `--vscode-errorForeground`, `in` lines prefixed with a dimmed `=>`, banner/info dimmed italic), auto-scroll pinned to bottom unless the user scrolled up. Content Security Policy with a nonce, no external resources. Protocol: webview posts `{type: "ready"}` → extension replies `{type: "reset", entries}` (full transcript); extension pushes `{type: "append", entry}` on new entries. Escape entry text in the webview before inserting (`textContent`, not `innerHTML`). Provider subscribes to the transcript's `onDidAppend`/`onDidClear` and exposes `reveal()` (focus the view via `clojurePulse.replView.focus` command).

- [x] **Step 3: Verify manually**
  Run: `make compile` then launch the Extension Development Host (F5), run "View: Open View… → REPL".
  Expected: empty REPL pane appears in the bottom panel next to Terminal.

- [x] **Step 4: Commit**
  `git commit -m "feat: add REPL webview panel in the bottom panel area"`

### Task 7: commands and wiring

**Files:**
- Modify: `package.json`
- Modify: `src/extension.ts`
- Test: `src/test/replCommands.integration.test.ts`

- [x] **Step 1: Write failing integration tests**
  After activation: `clojurePulse.connectRepl`, `clojurePulse.disconnectRepl`, `clojurePulse.evalSelection`, `clojurePulse.replMenu` are in `vscode.commands.getCommands()`; executing `clojurePulse.evalSelection` with no connection resolves without throwing (shows a warning); full loop against the fake nREPL server — connect via the manager, execute eval on a selection in a scratch Clojure document, assert the transcript contains the `in` and `value` entries.

- [x] **Step 2: Run tests to verify they fail**
  Run: `make test`
  Expected: FAIL — commands not registered.

- [x] **Step 3: Register commands in `package.json`**
  Category "Clojure Pulse": `connectRepl` ("Connect to Running nREPL"), `disconnectRepl` ("Disconnect from nREPL"), `evalSelection` ("Evaluate Selection"), `replMenu` ("REPL Menu"). Add an `enablement`/`when` is not needed — commands guard at runtime.

- [x] **Step 4: Wire everything in `extension.ts`**
  Instantiate `ConnectionManager`, `ReplPanelProvider`, `createReplStatusBar()` in `activate`; push all into `context.subscriptions`.
  - `connectRepl`: if connected, info message and return. Prompt host (`showInputBox`, value `localhost`), then port (pre-filled from `readNreplPort(workspaceRoot)`), validate integer 1–65535, then `manager.connect()`; reveal the REPL panel on success; `showErrorMessage` on failure.
  - `disconnectRepl`: `manager.disconnect()`, info message when not connected.
  - `evalSelection`: no connection → warning with a "Connect" button (runs connectRepl); empty selection → warning; otherwise `manager.eval(selectedText)` and reveal the panel.
  - `replMenu`: quick-pick with "Show REPL" (focus view) and "Disconnect".
  - Subscribe status bar updates to `manager.onDidChangeState`.
  Keep `deactivate` closing the REPL connection alongside the LSP client.

- [x] **Step 5: Run tests to verify they pass**
  Run: `make test`
  Expected: PASS (all suites).

- [x] **Step 6: Commit**
  `git commit -m "feat: add nREPL connect/disconnect/eval commands with REPL pane and status bar"`

### Task 8: end-to-end check and docs

**Files:**
- Modify: `README.md`, `CHANGELOG.md`

- [x] **Step 1: Manual end-to-end verification**
  Start a real nREPL in any Clojure project (`clj -M -m nrepl.cmdline` or `lein repl`), F5 the extension, run "Connect to Running nREPL" (port should pre-fill from `.nrepl-port`), confirm: banner with versions in the REPL pane, status bar shows `$(plug) nREPL localhost:<port>`, evaluating a selection prints code + value, `println` output appears as an `out` entry, disconnect updates pane and status bar, killing the nREPL process flips status to disconnected with an info entry.

- [x] **Step 2: Full check**
  Run: `make check`
  Expected: lint, compile, and tests all pass.

- [x] **Step 3: Update docs**
  README: new "REPL" section — connect command, `.nrepl-port` pre-fill, REPL pane, eval selection, status bar. CHANGELOG: entry under the unreleased version.

- [x] **Step 4: Commit**
  `git commit -m "docs: document nREPL connection and REPL pane"`

---

## Completion Summary (2026-07-06)

All 8 tasks implemented and committed; `make check` passes with 122 tests.

**What was built:** hand-rolled bencode codec (`src/nrepl/bencode.ts`), persistent
id-correlated `NreplClient` (`src/nrepl/client.ts`), capped `Transcript` model,
`ConnectionManager` with `.nrepl-port` discovery, REPL webview pane in the bottom
panel, REPL status bar item, and the `connectRepl` / `disconnectRepl` /
`evalSelection` / `replMenu` commands wired in `extension.ts` (which now returns
an `ExtensionApi` for integration tests).

**Deviations from the plan:**
- The connect banner uses `describe` versions only; the redundant
  `(clojure-version)` eval was dropped.
- This machine is headless, so the two manual GUI checks were replaced with
  equivalents: the REPL view resolution is exercised in the VS Code test host
  (`replCommands.integration.test.ts`), and Task 8's end-to-end run was done
  programmatically against a real nREPL 1.3.1 / Clojure 1.12.4 server
  (port discovery, banner, eval value, stdout streaming, divide-by-zero error
  as `err`, disconnect — all verified). A quick F5 smoke test on a desktop is
  still worthwhile.

**Issues found by per-task codex reviews, all fixed with regression tests:**
malformed bencode numeric fields accepted; transcript cap evictions invisible
to live views; handshake hang against non-nREPL services; socket leak on failed
handshake; disconnect-during-connecting not cancelling the attempt; stale
handshake failures reported as errors instead of cancellations.
