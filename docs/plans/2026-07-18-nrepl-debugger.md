# nREPL Debugger with Real Editor Breakpoints Implementation Plan

> **For agentic workers:** Use executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A native VS Code debugging experience for Clojure over the existing nREPL connection — gutter breakpoints, pause with locals in the Variables panel, step over/into/out, continue, and eval-in-frame — backed by the cider-nrepl debug middleware.

**Tech Stack:** TypeScript, VS Code Debug Adapter Protocol (`@vscode/debugadapter`, `@vscode/debugprotocol`), cider-nrepl debug middleware, existing bencode/nREPL client.

---

## Design

### Approach

Use the **cider-nrepl debug middleware** as the backend and implement a **DAP adapter inline in the extension** (no separate process). The native VS Code debug UI (paused editor, Variables panel, step toolbar, Debug Console) drives the CIDER debug protocol over the extension's existing nREPL connection.

cider-nrepl instruments code at *read time*: a form only pauses execution if it was evaluated with a break marker in it. The extension makes gutter breakpoints real by **injecting `#break` markers into the code it sends to nREPL, invisibly** — the user's buffer is never modified.

### End-to-end flow

1. **Connect.** After nREPL connect, check `describe` for the `init-debugger` op (present when cider-nrepl is loaded). If present, send `init-debugger` — a request that never completes; the server streams break events on it. If absent, breakpoints stay unverified and debug commands show an actionable "add cider-nrepl middleware to your REPL" message.
2. **Set breakpoints.** A `breakpoints` contribution enables the gutter for Clojure files. VS Code tracks breakpoints globally (`vscode.debug.breakpoints`) — no debug session needed. On any breakpoint change, the extension finds the enclosing top-level form of each affected breakpoint and **silently re-evaluates it** with `#break ` injected before the first form on each breakpointed line. Removing the last breakpoint in a form re-evals it clean (de-instruments). Eval commands cooperate: "Evaluate Current Form" injects markers for breakpoints inside the form; "Evaluate File" (load-file) re-instruments breakpointed forms after the load completes (load-file itself does not instrument).
3. **Hit a break.** Instrumented code sends a message with `status: ["need-debug-input"]` carrying the current value, locals, and a coordinate path (`coor`) into the top-level form. The extension **auto-starts the debug session** (`vscode.debug.startDebugging`) — no F5, no launch.json.
4. **Debug.** One thread, one stack frame positioned by mapping `coor` back to a buffer position (offset-corrected for injected marker text — markers are inline, so lines never shift, only columns on breakpointed lines). Variables panel lists locals. Step Over/Into/Out/Continue send `:next`/`:in`/`:out`/`:continue` via the `debug-input` op. Debug Console evaluates in the paused frame's context. Stopping the session sends `:quit`. The current step value is also shown as inline ghost text at the paused position (CIDER-overlay style), reusing the inline-results infrastructure.

### Key decisions

- **Gutter breakpoints via invisible `#break` injection + auto re-instrumentation on breakpoint changes.** The user clicks the gutter and it just works for the next call of that function.
- **cider-nrepl is a user-provided prerequisite.** The extension attaches to running REPLs (no jack-in), so users add `cider/cider-nrepl` middleware to their REPL startup. Detected via `describe`; absence produces a clear message, never a silent failure.
- **Inline DAP adapter** using `@vscode/debugadapter` — standard library, no extra process.
- **Coor→position mapping built on the reader in `forms.ts`**; on any mapping failure, fall back to highlighting the whole top-level form rather than erroring.
- **Single frame, single thread.** The CIDER protocol exposes only the current break frame (no JVM stack walk) — same as Calva.
- **Honest verification state.** A breakpoint shows verified only when its enclosing form was successfully instrumented. Not connected, middleware missing, or eval failed (e.g. namespace not loaded) → unverified.
- **`#break`/`#dbg` typed in source still work for free**, and a bonus command "Debug Current Top-Level Form" evals the current top-level form with `#dbg` prefixed (step through a function without placing breakpoints).
- **Semantics caveat:** cider's `#break` pauses when the marked form *produces its value* ("pause at the first expression on this line, with its value in hand"), not "pause before this line runs". Stepping feels the same; document it.

### Known limits (v1)

- Breakpoints only bind in code (re)evaluated through the REPL; a process running stale definitions won't pause. Inherent to the nREPL approach (true for CIDER and Calva too).
- No conditional breakpoints, logpoints, function breakpoints, or run-to-cursor (`:here`). cider supports `:break/when` metadata — future work.
- JVM Clojure only; let-go/`.lg` out of scope.

### CIDER debug protocol (expected shapes — verify in Task 1)

- Client → `{op: "init-debugger"}`: held open forever; break events arrive as responses on this request's id.
- Break event: `status: ["need-debug-input"]`, plus `key` (reply token), `coor` (int vector into the top-level form's sexp tree), `file`, `line`, `column` (top-level form start), `debug-value` (printed value at the break point), `locals` (list of `[name, printed-value]` pairs), `input-type` (allowed commands).
- Client → `{op: "debug-input", key, input}` where `input` is an edn string: `":next"`, `":in"`, `":out"`, `":continue"`, `":quit"`, and for in-frame eval something like `"{:response :eval, :code \"...\"}"`.
- Map/set coordinate traversal has quirks (cider addresses flattened key/value order); handle lists/vectors/maps by ordered child index and rely on the whole-form fallback otherwise.

### Testing strategy

Pure logic (top-level form finding, marker injection, coor mapping) gets unit tests. Protocol flow (init-debugger, break event, debug-input replies, verification states) is tested against the existing `fakeNreplServer`, extended with debug ops. The DAP adapter's request handlers are tested by driving them directly with protocol requests. Final task is a manual end-to-end check against a real REPL with cider-nrepl.

## File Structure

Create:
- `src/debug/protocol.ts` — typed interfaces for CIDER debug messages + protocol notes (single source of truth for wire shapes).
- `src/debug/instrument.ts` — pure: inject `#break ` markers into a form's text for given breakpoint offsets; returns injected text + injection records for offset back-mapping.
- `src/debug/coor.ts` — pure: coor path → offset range in text (via `forms.ts` reader), plus reverse offset adjustment through injection records; whole-form fallback.
- `src/debug/breakpointSync.ts` — listens to `vscode.debug.onDidChangeBreakpoints` + connection state; debounced re-instrumentation of affected top-level forms; tracks instrumented forms (doc version, injections) and verification state.
- `src/debug/debugManager.ts` — owns `init-debugger` lifecycle, current break state, auto-starting the VS Code debug session, and the bridge the adapter talks to.
- `src/debug/debugAdapter.ts` — inline `DebugSession` subclass: initialize/attach/threads/stackTrace/scopes/variables/next/stepIn/stepOut/continue/evaluate/disconnect.
- `src/test/instrument.test.ts`, `src/test/coor.test.ts`, `src/test/breakpointSync.test.ts`, `src/test/debugManager.test.ts`, `src/test/debugAdapter.test.ts`.

Modify:
- `src/repl/forms.ts` — export top-level form lookup and child-form walking needed by instrument/coor.
- `src/repl/connectionManager.ts` — debug capability flag from `describe`, `initDebugger(onEvent)`, `sendDebugInput(key, input)`.
- `src/test/fakeNreplServer.ts` — support `init-debugger` (hold open), `debug-input`, and a describe response advertising debug ops.
- `src/extension.ts` — wire breakpointSync + debugManager + adapter factory + new command; eval commands inject markers.
- `package.json` — `breakpoints` + `debuggers` contributions, "Debug Current Top-Level Form" command, new dependencies.
- `README.md`, `CHANGELOG.md` — document the feature, prerequisite, and semantics caveat.

---

### Task 1: Verify the CIDER debug protocol details

**Files:**
- Create: `src/debug/protocol.ts`

- [ ] **Step 1: Research the exact wire shapes**
  Fetch and read the authoritative sources: `cider-nrepl`'s `src/cider/nrepl/middleware/debug.clj` (GitHub) and Calva's `src/calva-debug.ts`. Confirm: field names in the break event (`key`, `coor`, `file`, `line`, `column`, `debug-value`, `locals`, `input-type`), the `debug-input` input encodings for next/in/out/continue/quit and in-frame eval, **whether `debug-input` receives any completion/`done` response at all** (drives Task 5's send mechanism), **how an `:eval` input's result comes back** (expected: a follow-up `need-debug-input` event carrying the result while still paused — drives Task 7's correlation), whether `init-debugger` must share the eval session, how instrumentation interacts with `load-file`, and map/set coor traversal rules.

- [ ] **Step 2: Write `src/debug/protocol.ts`**
  Typed interfaces for the break event and input commands, with a comment block recording the verified findings (including any correction to this plan's assumptions). No logic.

- [ ] **Step 3: Compile and commit**
  Run: `npm run compile` — Expected: success.
  `git commit -m "feat: add cider debug protocol types"`

### Task 2: Top-level form and child-form lookup in forms.ts

**Files:**
- Modify: `src/repl/forms.ts`
- Test: `src/test/forms.test.ts`

- [ ] **Step 1: Write failing tests**
  `topLevelFormAt(text, offset)`: the top-level form range enclosing (or exactly at) `offset`, else null. `childForms(text, range)`: ordered child form ranges of a bracketed form (reader prefixes attached to their form, `#_` forms skipped — instrumented code is what the server read, so match reader semantics). Cover: comments, strings with brackets, reader conditionals, metadata, discard forms.

- [ ] **Step 2: Run tests to verify they fail**
  Run: `npm test` — Expected: new tests FAIL.

- [ ] **Step 3: Implement using the existing `readForm` machinery**
  Export thin wrappers; do not duplicate the reader.

- [ ] **Step 4: Run tests, lint**
  Run: `npm test` — Expected: PASS.

- [ ] **Step 5: Commit**
  `git commit -m "feat: expose top-level and child form lookup in forms reader"`

### Task 3: Breakpoint marker injection (pure)

**Files:**
- Create: `src/debug/instrument.ts`
- Test: `src/test/instrument.test.ts`

- [ ] **Step 1: Write failing tests**
  `injectBreakMarkers(formText, formStart, breakpointLines, docText)` (settle the exact signature during implementation) returns `{ code, injections }` where `injections` is a sorted list of `{ offset, length }` insertions relative to the original form text. Behavior: for each breakpoint line inside the form, inject `#break ` before the first form starting on that line; a line with no form start gets no injection (report it so the breakpoint can be marked unverified); injections never add newlines; multiple breakpoints in one form all inject; a breakpoint on the form's own first line taggs the whole form.

- [ ] **Step 2: Run tests to verify they fail**
  Run: `npm test` — Expected: FAIL.

- [ ] **Step 3: Implement using Task 2's form lookup**

- [ ] **Step 4: Run tests**
  Run: `npm test` — Expected: PASS.

- [ ] **Step 5: Commit**
  `git commit -m "feat: inject #break markers for editor breakpoints"`

### Task 4: Coordinate → source position mapping (pure)

**Files:**
- Create: `src/debug/coor.ts`
- Test: `src/test/coor.test.ts`

- [ ] **Step 1: Write failing tests**
  `rangeFromCoor(sentCode, coor)` walks the sexp tree by child index (per Task 1 findings — including how `#break`/`#dbg` tags and metadata are counted) and returns the offset range in the *sent* code, or null when the path doesn't resolve. `toBufferOffset(offset, injections)` subtracts injected lengths before the offset to recover buffer positions. Include a whole-form fallback contract: callers use the top-level form range when mapping fails. Cover lists, vectors, maps, threading macros, and a coor that runs off the tree.

- [ ] **Step 2: Run tests to verify they fail**
  Run: `npm test` — Expected: FAIL.

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run tests**
  Run: `npm test` — Expected: PASS.

- [ ] **Step 5: Commit**
  `git commit -m "feat: map cider debug coordinates to source positions"`

### Task 5: ConnectionManager debug ops + fake server support

**Files:**
- Modify: `src/repl/connectionManager.ts`, `src/test/fakeNreplServer.ts`
- Test: `src/test/connectionManager.test.ts`

- [ ] **Step 1: Extend fakeNreplServer**
  Describe response advertises `init-debugger`/`debug-input` ops (configurable); `init-debugger` requests are held open with a handle tests use to emit break events; `debug-input` requests are recorded and answered **exactly as the real middleware does per Task 1's findings** — if cider-nrepl sends no `done` for `debug-input`, the fake must not either.

- [ ] **Step 2: Write failing tests**
  `ConnectionManager` gains: `hasDebugMiddleware` (from the `describe` already performed at connect), `initDebugger(onEvent)` (sends the op on the active connection, routes each `need-debug-input` message to `onEvent`, survives for the connection's lifetime), `sendDebugInput(key, input)`. If Task 1 found that `debug-input` gets no completion response, add a fire-and-forget send path to `NreplClient` (e.g. `sendNoReply(request)` that writes without registering a pending entry) and use it for `sendDebugInput` — `send()`'s wait-for-`done` would otherwise leak a pending request per step command. Test: middleware detection true/false, break event routing, input sending (asserting no pending-request leak after many inputs), and that disconnect cleans up without rejecting into user-visible errors (the held-open `init-debugger` request's rejection on close is expected).

- [ ] **Step 3: Run tests to verify they fail**
  Run: `npm test` — Expected: FAIL.

- [ ] **Step 4: Implement**
  Keep the surface narrow — the manager exposes debug ops; instrumentation stays in the debug layer.

- [ ] **Step 5: Run tests**
  Run: `npm test` — Expected: PASS.

- [ ] **Step 6: Commit**
  `git commit -m "feat: add debug middleware ops to connection manager"`

### Task 6: BreakpointSync — instrument on breakpoint changes

**Files:**
- Create: `src/debug/breakpointSync.ts`
- Test: `src/test/breakpointSync.test.ts`

- [ ] **Step 1: Write failing tests**
  Factor the decision logic pure (given breakpoints + document text + previous instrumented state, compute which top-level forms to (re)eval, with what injected code, and which breakpoints become verified/unverified) and test it directly. Cases: add first breakpoint in a form → instrumented eval; add second in same form → single re-eval with both markers; remove last → clean re-eval; breakpoint on a blank/comment line → unverified, no eval; eval failure (namespace-not-found) → unverified; disconnected or no middleware → all unverified, no evals; reconnect → initial sync instruments all existing breakpoints.

- [ ] **Step 2: Run tests to verify they fail**
  Run: `npm test` — Expected: FAIL.

- [ ] **Step 3: Implement the VS Code shell**
  Subscribe to `vscode.debug.onDidChangeBreakpoints` and connection state changes; debounce ~300 ms; evaluate via `ConnectionManager.eval` with the form's real `file`/`line`/`column` extras (so coor line info maps back) **and the document's namespace via `nsBefore` (as `evalCurrentForm` does — without `ns`, the re-eval would define the var in the current REPL namespace and leave the real function uninstrumented; include a test for this)**; record per-form instrumented state `{ uri, formRange, injections, docVersion }` for the coor mapper; expose it to the debug manager. Do not write to the transcript for silent instrumentation evals, or mark them distinctly — decide by reading how the transcript is used and keep the REPL pane readable.

- [ ] **Step 4: Run tests**
  Run: `npm test` — Expected: PASS.

- [ ] **Step 5: Commit**
  `git commit -m "feat: instrument breakpointed forms on breakpoint changes"`

### Task 7: DebugManager + inline DAP adapter

**Files:**
- Create: `src/debug/debugManager.ts`, `src/debug/debugAdapter.ts`
- Modify: `package.json` (dependencies: `@vscode/debugadapter`, `@vscode/debugprotocol`)
- Test: `src/test/debugManager.test.ts`, `src/test/debugAdapter.test.ts`

- [ ] **Step 1: Write failing tests for DebugManager**
  On connect with middleware: sends `init-debugger`. On break event: stores it and requests a debug session start exactly once (inject the starter so tests don't need `vscode.debug`); further break events while a session is active reuse it. Maps the event to a buffer location: prefer the instrumented-state record from breakpointSync (offset-correct via injections; on doc version mismatch or mapping failure, fall back to the whole top-level form located from the event's `file`/`line`). Step/continue/quit calls forward as `debug-input` with the stored `key`. Session end sends `:quit` if paused; connection loss ends the session.

- [ ] **Step 2: Write failing tests for the adapter**
  Drive the `DebugSession` subclass with DAP requests against a stubbed DebugManager: `initialize` (capabilities: no conditional breakpoints, supports evaluate for hovers off), `attach`, `threads` (one thread), `stackTrace` (one frame, name = the paused function/top-level form head, source + mapped line/column), `scopes` ("Locals"), `variables` (locals pairs, plus a first entry showing the break point's current value), `next`/`stepIn`/`stepOut`/`continue` → the matching inputs, `evaluate` → in-frame `:eval` with explicit result correlation per Task 1 findings — the result arrives as a *follow-up* `need-debug-input` event while still paused, so DebugManager must track a pending-evaluate state that consumes that event into the `EvaluateResponse` (updating the stored `key`) *without* emitting a `stopped` event or moving the paused position; test both a normal step stop and an evaluate round-trip to prove they're distinguished. `disconnect` → `:quit`. `setBreakpoints` responds with verification states from breakpointSync (breakpoint mutation itself keeps flowing through `onDidChangeBreakpoints`).

- [ ] **Step 3: Run tests to verify they fail**
  Run: `npm test` — Expected: FAIL.

- [ ] **Step 4: Implement**
  Install the two dependencies. Adapter emits a `stopped` event (reason "breakpoint" on first hit, "step" after step inputs) when DebugManager reports a break. Show the `debug-value` as inline ghost text at the paused position via the existing inline-results renderer, cleared on resume/step.

- [ ] **Step 5: Run tests**
  Run: `npm test` — Expected: PASS.

- [ ] **Step 6: Commit**
  `git commit -m "feat: add inline DAP adapter over cider debug protocol"`

### Task 8: Wire-up, contributions, and eval-command cooperation

**Files:**
- Modify: `package.json`, `src/extension.ts`

- [ ] **Step 1: package.json contributions**
  `breakpoints: [{ "language": "clojure" }]`; `debuggers` entry: type `clojure-pulse`, label "Clojure Pulse", attach request with no required properties; command `clojurePulse.debugCurrentForm` ("Debug Current Top-Level Form").

- [ ] **Step 2: Wire in extension.ts**
  Register a `DebugAdapterDescriptorFactory` returning `DebugAdapterInlineImplementation`, a minimal `DebugConfigurationProvider` (so F5 also works), breakpointSync + debugManager construction/disposal tied to the ConnectionManager. `debugCurrentForm`: eval the current top-level form with `#dbg ` prefixed (error message when middleware is missing). Eval commands: "Evaluate Current Form"/"Evaluate Selection" inject markers for breakpoints inside the sent range; "Evaluate File" re-instruments breakpointed forms after load-file completes (per Task 1 findings on load-file).

- [ ] **Step 3: Full test suite and lint**
  Run: `npm test` — Expected: PASS (includes pretest lint + compile).

- [ ] **Step 4: Commit**
  `git commit -m "feat: wire clojure debugger into extension"`

### Task 9: Manual end-to-end verification and docs

**Files:**
- Modify: `README.md`, `CHANGELOG.md`

- [ ] **Step 1: Manual E2E against a real REPL**
  Start a sample deps.edn project's nREPL with cider-nrepl middleware (`clojure -Sdeps '{:deps {cider/cider-nrepl {:mvn/version "RELEASE"}}}' -M -m nrepl.cmdline --middleware '[cider.nrepl/cider-middleware]'`). In the Extension Development Host: connect; set a gutter breakpoint in a defn; call the function from the REPL pane; verify the session auto-starts, the editor pauses at the breakpoint with locals shown; step over/into/out; evaluate a local in the Debug Console; continue; remove the breakpoint and verify the next call doesn't pause; verify the missing-middleware message against a plain nREPL. Fix what fails.

- [ ] **Step 2: Document**
  README: debugging section — prerequisite middleware snippet, gutter workflow, `#break`/`#dbg` tags, the "pauses when the expression produces its value" semantics note, and the "code must be (re)evaluated through the REPL" limit. CHANGELOG entry.

- [ ] **Step 3: Commit**
  `git commit -m "docs: document nrepl debugger"`
