# Log Server Version on Startup Implementation Plan

> **For agentic workers:** Use executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Write one line to the "Clojure Pulse" output channel each time the language server comes up, naming the extension version, the clj-pulse version, where the binary came from, and its path.

**Tech Stack:** TypeScript, VS Code extension API, `vscode-languageclient`, Mocha through `@vscode/test-cli`.

---

## Design

### Problem

The output channel records `starting server: <command> (<source>)` before the
spawn (`src/extension.ts`, `start()`) and nothing once the server is up. The
running server's version is known to the extension from the `initialize`
response (`client.initializeResult.serverInfo.version`) but only reaches the
user as a status-bar tooltip. `docs/troubleshooting.md` asks bug reporters for
"the extension/server versions", and today there is no single place to copy
them from.

### The line

Each time the client reaches the Running state, `start()`'s state listener appends:

```
[clojure-pulse] extension v0.6.0, server clj-pulse v0.5.4 (bundled): /home/me/.vscode/extensions/abogoyavlensky.clojure-pulse-0.6.0-linux-x64/server/clj-pulse
```

The shape is always `extension v<ext>, server <name> <version> (<source>): <command>`.
Only the version part degrades when a server predates `serverInfo`:

```
[clojure-pulse] extension v0.6.0, server clj-pulse (version unknown, path): /usr/local/bin/clj-pulse
```

- `<name>` is `serverInfo.name`, falling back to `clj-pulse`.
- `<version>` is `v` + `serverInfo.version`; when absent the parenthesis
  reads `(version unknown, <source>)` so the line never looks complete
  when it is not.
- `<source>` is the `ServerSource` value verbatim (`bundled`, `path`,
  `explicit`), the same words the "starting server" line prints, so the
  two lines read as a pair.
- `<command>` is the resolved path from `resolveServerPath`.

No new process is spawned and clj-pulse is not changed: everything on the
line is already in hand on the extension side.

### Where it is emitted

In the `onDidChangeState` listener that `start()` registers in
`src/extension.ts`, whenever `event.newState === State.Running`. That is the
one place every start passes through: the first `start()`, the Restart
Language Server command (which calls `start()` again), and the automatic
restart `vscode-languageclient` performs after a server crash
(`CloseAction.Restart`, which re-runs `start()` inside the client without
touching our `.then()`). The client re-runs `initialize` on each of those,
so `newClient.initializeResult` is fresh at every Running transition. A
failed spawn never reaches Running, so it never logs a ready line.

The `.then()` after `newClient.start()` is not used: it fires once per
client and would miss crash restarts.

### Extension version

Read once in `activate()` from `context.extension.packageJSON.version` into
a module-level `extensionVersion` variable, the same pattern as
`bundledServerPath`. No import of `package.json` into the bundle.

### Formatter

A pure, exported `serverReadyLine(extensionVersion, detail)` in
`src/statusBar.ts`, next to `statusPresentation`, consuming the same
`serverInfo`, `command`, and `source` fields the tooltip already reads. It
returns the text after the `[clojure-pulse] ` prefix; `extension.ts` adds
the prefix as it does for every other line. Keeping it pure means the string
is unit-tested without VS Code, matching how the status bar is tested.

Signature both tasks must agree on:

```ts
export function serverReadyLine(
  extensionVersion: string,
  detail: { serverInfo?: ServerInfo; command: string; source: ServerSource },
): string
```

`command` and `source` are required, not `Pick`ed from `StatusDetail`: the
call site always has both from `resolveServerPath`, and an optional type
would let `undefined` leak into the line.

### Testing

Unit tests in `src/test/statusBar.test.ts` cover: version present, version
absent, and the source label in both cases. No integration test: the append
is one line of wiring in a listener the jar end-to-end test already runs.
Manual verification covers the manual restart and a crash restart.

### Docs

One sentence in the "Reporting a problem" section of
`docs/troubleshooting.md` pointing reporters at the startup line in the
Clojure Pulse output channel.

## File Structure

- Modify: `src/statusBar.ts` — add `serverReadyLine`.
- Modify: `src/test/statusBar.test.ts` — unit tests for `serverReadyLine`.
- Modify: `src/extension.ts` — read `extensionVersion` in `activate()`; append the line in `start()`.
- Modify: `docs/troubleshooting.md` — tell reporters where the versions are.

## Tasks

### Task 1: `serverReadyLine` formatter

**Files:**
- Modify: `src/statusBar.ts`
- Test: `src/test/statusBar.test.ts`

- [ ] **Step 1: Write the failing tests**
  Add a `suite("serverReadyLine", ...)` to `src/test/statusBar.test.ts` with
  four tests:
  - Full detail (`serverInfo: { name: "clj-pulse", version: "0.5.4" }`,
    `command: "/ext/server/clj-pulse"`, `source: "bundled"`) with extension
    version `"0.6.0"` returns exactly
    `extension v0.6.0, server clj-pulse v0.5.4 (bundled): /ext/server/clj-pulse`.
  - No `serverInfo`, `source: "path"`, `command: "/usr/local/bin/clj-pulse"`
    returns exactly
    `extension v0.6.0, server clj-pulse (version unknown, path): /usr/local/bin/clj-pulse`.
  - `serverInfo` with a `name` but no `version` still prints
    `(version unknown, <source>)`, and uses that name.
  - `source: "explicit"` appears verbatim in the parenthesis.

- [ ] **Step 2: Run the tests to verify they fail**
  Run: `npm run compile-tests` then `make test`
  Expected: the compile fails because `serverReadyLine` is not exported from
  `../statusBar`.

- [ ] **Step 3: Implement `serverReadyLine`**
  In `src/statusBar.ts`, after `statusPresentation`, add the exported
  function with the signature from the design. Build the name from
  `detail.serverInfo?.name ?? "clj-pulse"`; when `detail.serverInfo?.version`
  is set, emit `v<version> (<source>)`, otherwise
  `(version unknown, <source>)`. Finish with `: <command>`. Add a short doc
  comment saying this is the output-channel startup line and why the
  version degrades but the source never does. Do not touch `statusPresentation`.

- [ ] **Step 4: Run the tests to verify they pass**
  Run: `make test`
  Expected: PASS, including the four new `serverReadyLine` tests and all
  existing `statusPresentation` tests.

- [ ] **Step 5: Lint**
  Run: `npm run lint`
  Expected: no errors.

- [ ] **Step 6: Commit**
  `git commit -m "Add serverReadyLine formatter for the output channel"`

### Task 2: Emit the line on every server start

**Files:**
- Modify: `src/extension.ts`

- [ ] **Step 1: Store the extension version**
  Add `let extensionVersion = "";` next to `bundledServerPath` in the
  module globals. In `activate()`, right after `bundledServerPath` is set,
  assign `extensionVersion = String(context.extension.packageJSON.version)`.
  Import `serverReadyLine` from `./statusBar` alongside the existing
  status-bar imports.

- [ ] **Step 2: Append the line on every Running transition**
  In `start()`, inside the `stateListener = newClient.onDidChangeState(...)`
  callback, after `repaintStatus(...)`, add:
  ```ts
  if (event.newState === State.Running) {
    outputChannel?.appendLine(
      `[clojure-pulse] ${serverReadyLine(extensionVersion, {
        serverInfo: newClient.initializeResult?.serverInfo,
        command: resolution.command,
        source: resolution.source,
      })}`,
    );
  }
  ```
  Extend the comment on the listener with one sentence: the ready line is
  logged here rather than in `start().then()` because the client restarts
  itself after a crash and only this listener sees that Running transition.

- [ ] **Step 3: Type-check and bundle**
  Run: `npm run compile`
  Expected: succeeds with no type errors.

- [ ] **Step 4: Run the suite**
  Run: `make test`
  Expected: PASS. The jar end-to-end test starts a real server, so the new
  line runs through the real `initializeResult`.

- [ ] **Step 5: Verify in the editor**
  Run: `make package && make install-extension`, reload the window, run
  "Clojure Pulse: Show Language Server Output".
  Expected: immediately after `starting server: ... (bundled)` a line
  `extension v0.6.0, server clj-pulse v0.5.4 (bundled): <path>` appears.
  Run "Clojure Pulse: Restart Language Server".
  Expected: both lines appear again.
  Kill the server process from a terminal (`pkill -f server/clj-pulse`).
  Expected: the client restarts it on its own and a new ready line appears
  without a new "starting server" line.

- [ ] **Step 6: Commit**
  `git commit -m "Log extension and server versions when the server is ready"`

### Task 3: Point bug reporters at the line

**Files:**
- Modify: `docs/troubleshooting.md`

- [ ] **Step 1: Edit "Reporting a problem"**
  After the sentence listing what to include, add one sentence: the
  startup line in the Clojure Pulse output channel ("Clojure Pulse: Show
  Language Server Output") carries the extension version, the server version, and the
  server path, so that one line covers the version details. Use
  /writing-clearly.

- [ ] **Step 2: Commit**
  `git commit -m "Docs: name the output-channel line that carries both versions"`
