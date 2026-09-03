# nREPL Debugger with Gutter Breakpoints Implementation Plan

> **For agentic workers:** Use executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A native VS Code debugging experience for Clojure over the existing nREPL connection: gutter breakpoints, pause with locals in the Variables panel, step over/into/out, continue, and Debug Console evaluation in the paused frame, backed by the cider-nrepl debug middleware, which the default REPL command now includes.

**Tech Stack:** TypeScript (VS Code extension), `@vscode/debugadapter` + `@vscode/debugprotocol` 1.68 (inline Debug Adapter Protocol implementation), cider-nrepl 0.62.2 debug middleware, nREPL 1.7.0, the existing bencode client and forms reader, `@vscode/test-cli` + xvfb harness.

This plan supersedes `docs/plans/2026-07-18-nrepl-debugger.md`, which injected `#break` per breakpointed line. That approach pauses after the tagged form *yields*, so a breakpoint on a `when`, `let`, or `defn` line paused after the whole body had run. This plan instruments the enclosing top-level form with `#dbg` and steers the pause from the client instead. The old plan stays in the repository for history; Task 15 marks it superseded.

---

## Design

### Approach

The **cider-nrepl debug middleware** is the backend. A **Debug Adapter Protocol (DAP) adapter runs inline in the extension** (`vscode.DebugAdapterInlineImplementation`, no extra process) and translates the native VS Code debug UI into the CIDER debug protocol over the extension's existing nREPL connection. A debug session **auto-starts on the first pause**; no F5 and no `launch.json` are needed, though a minimal `DebugConfigurationProvider` lets F5 start an idle attach session too.

cider-nrepl instruments code at read time: a form pauses only if it was evaluated with a debug tag in it. Gutter breakpoints become real by **evaluating the enclosing top-level form with a `#dbg ` prefix**, silently, and never touching the user's buffer. `#dbg` instruments every evaluable sub-form, so the middleware pauses at each one; the extension decides per pause whether to **show it** (a breakpoint line was reached), **skip ahead** with the protocol's run-to-coordinate command, or **continue**. Because the sent code is a fixed prefix plus the original form text, the coordinates the middleware reports map straight onto the buffer; there are no injection offsets to track.

Two clients already use this backend and architecture (CIDER itself and Calva). Calva does not implement gutter breakpoints; this plan does.

### Verified protocol facts

Verified in September 2026 against cider-nrepl master (`src/cider/nrepl/middleware/debug.clj`, `util/instrument.clj`) and the cider-nrepl docs. Task 2 re-verifies against the **`v0.62.2` tag**, the version the default command pins, and records the details in `src/debug/protocol.ts`; anything found different there wins over this section.

- **Loading.** `cider/cider-nrepl {:mvn/version "0.62.2"}` plus `--middleware "[cider.nrepl/cider-middleware]"`. Needs Clojure 1.10+ and Java 8+. cider-nrepl defers loading each middleware namespace, so startup cost is small. nREPL's runtime `add-middleware` op existed from 0.8 to 1.3 and is gone in 1.7, so the middleware **must be in the startup command**; there is no runtime injection.
- **Detection.** The `describe` response's `ops` map contains `init-debugger` and `debug-input` when the middleware is loaded. The extension already runs `describe` on connect (`src/repl/connectionManager.ts:117`).
- **`init-debugger`.** A request the server holds open forever, stored in a server-side atom; every break event is sent as a response to this request's `id` with `status: ["need-debug-input"]`. Send it once per connection.
- **Break event fields.** `key` (reply token, a fresh UUID per event), `coor` (list of ints, a path into the instrumented top-level form's sexp tree), `code` (the instrumented top-level code string exactly as evaluated), `file`, `line`, `column` (the top-level form's position from the eval message, or from the reader for `load-file`), `debug-value` (printed value at the pause), `locals` (list of `[name, printed-value]` pairs), `input-type` (allowed commands), `prompt`.
- **`debug-input`.** Params `key` and `input` (an EDN string). **The server sends no reply at all, not even `done`**, so it must be fire-and-forget on the client. Inputs: `":next"`, `":in"`, `":out"`, `":continue"`, `":continue-all"`, `":quit"`, `"{:response :here :coord [2 1 0]}"`, `"{:response :eval :code \"(+ 1 2)\"}"`. Task 2 confirms the exact encoding.
- **Semantics.** `:continue` skips the remaining breaks of the **current invocation** of the instrumented function (a per-invocation `:skip` flag); the next call pauses again. `:continue-all` skips for the rest of the eval session. `:here coord` sets a skip that suppresses every break whose coordinate is *before* `coord` in the same code; the break at or after it pauses. The skip state (`*skip-breaks*`) is reset at the start of each top-level eval session and when an invocation re-hits its first coordinate (loops). `:out` skips deeper than the parent coordinate. `:quit` aborts the eval thread.
- **`:eval`.** The result comes back as a **new `need-debug-input` event** at the same coordinate with `debug-value` set to the printed result and a **new `key`**. No separate message.
- **`#dbg` on a `defn`.** Evaluating the defn does not pause. Each call pauses at the first instrumented sub-form executed.
- **`load-file`.** On nREPL 1.5+ the debug middleware installs a custom read function, so forms carrying `#dbg`/`#break` tags in a `load-file` buffer are instrumented too.
- **Coordinates.** Children of a list or vector are indexed from 0 **including the head**. Map entries are addressed positionally: key at `2i`, value at `2i+1`, in insertion order for maps of 8 entries or fewer (sorted keys above that). Sets are not instrumented. Coordinates refer to the **original pre-macroexpansion source structure**. Binding names in `let`/`loop`/`fn` are not instrumented; their values are. Quoted forms are not instrumented.

### End-to-end flow

1. **Connect.** After the handshake the connection exposes `hasDebugMiddleware` from `describe`. If present, the extension sends `init-debugger` and routes every `need-debug-input` message to that REPL's `CiderBackend`.
2. **Set a breakpoint.** The `breakpoints` contribution enables the gutter for Clojure files; VS Code tracks breakpoints globally in `vscode.debug.breakpoints`, no session needed. `BreakpointSync` groups enabled breakpoints by enclosing top-level form, and for each *defn-family* form that gained its first breakpoint evaluates `#dbg <form text>` silently in the file's namespace with real `file`/`line`/`column`. Removing a form's last breakpoint re-evaluates the recorded snapshot without the prefix to de-instrument. Breakpoints in other forms stay unverified with a reason.
3. **Hit a break.** The backend maps the event to a record (by exact `code` match, else by `file` + `line`), maps `coor` to a range in the buffer, and runs the pure decision function (below). "Show" starts the VS Code debug session if none is running (`vscode.debug.startDebugging`) and emits a `stopped` event; "here" and "continue" send the matching `debug-input` and stay silent.
4. **Debug.** One thread, one frame positioned at the mapped range. The Variables panel shows a `Locals` scope with the pause value first, then each local. Step Over/Into/Out send `:next`/`:in`/`:out`; Continue sends `:here` to the next breakpoint in the form, else `:continue`. The Debug Console evaluates in the paused frame via `:eval`. The pause value is also drawn as inline ghost text at the paused form, cleared on resume. Stopping the session sends `:quit` if paused.
5. **Eval commands cooperate.** Evaluate Current Form and every `load-file` command (Evaluate File, Run Test at Cursor, Run Tests in Namespace) inject `#dbg ` in front of each top-level form that currently has breakpoints before sending, and refresh the sync records afterwards. Instrumentation survives a reload with no extra round trip.

### From a pause to a decision

A pure function `decideOnPause(input)` in `src/debug/decision.ts` drives every pause. Input:

```ts
interface DecisionInput {
  kind: "breakpoints" | "dbgCommand" | "unknown"; // how the form got instrumented
  mode: "auto" | "stepping";                      // stepping after :next/:in/:out
  lastAction: "none" | "continue" | "here" | "next" | "step";
  hereTargetLine?: number;   // set when lastAction === "here"
  pauseStartLine: number;    // buffer lines of the range coor maps to
  pauseEndLine: number;
  breakpointLines: number[]; // enabled breakpoint lines inside this form, sorted
}
type Decision =
  | { action: "show"; reason: "breakpoint" | "step" }
  | { action: "here"; targetLine: number }
  | { action: "next" }
  | { action: "continue" };
```

Rules, first match wins:

1. `kind` is `dbgCommand` or `unknown` → show. Reason `step` in stepping mode, else `breakpoint`. (Debug Current Top-Level Form and hand-typed `#dbg` behave like CIDER: every pause shows.)
2. `mode` is `stepping` → show, reason `step`.
3. Some breakpoint line `L` satisfies `pauseStartLine <= L <= pauseEndLine` → show, `breakpoint`. A pause "is on" every line its form spans, so a breakpoint on the last line of a multi-line call fires when that call yields.
4. `lastAction` is `none` or `continue` (this is the first pause we see in an invocation) and some `L <= pauseEndLine` → show, `breakpoint`. This covers a breakpoint on the defn's first line (function entry), on a docstring or argument-vector line, and on lines with no evaluable form.
5. `lastAction` is `here` and `pauseEndLine >= hereTargetLine` → show, `breakpoint`. The run-to-coordinate skip guarantees the next pause is at or after the target; when control flow skipped the exact line, this pauses at the next evaluated expression after it, which is CIDER's own `:here` behaviour.
6. Some `L > pauseEndLine` → `here` with the smallest such `L`. The backend converts the line to a coordinate with `coorForLine`; if that fails it sends `:next` instead and the rules run again on the next pause.
7. Otherwise → `continue`.

Continue button while paused: if a breakpoint line lies after the current pause's end line, send `:here` to it (rule 6's target), so a later breakpoint in the same invocation still fires; else send `:continue`. Task 2 checks whether a `:here` skip leaks into the next invocation of the same function within one eval session. If it does, "continue with no later breakpoint" becomes two steps: `:here [0]` (a coordinate nothing is before, so it only clears the skip and resumes), then `:continue` on the pause that follows. Record the outcome in `protocol.ts` and implement whichever applies; `decision.ts` exposes it as a flag so tests cover both.

Mode transitions: a step command enters `stepping`; Continue returns to `auto`; a new session or quit resets to `auto`/`none`. Additional pauses that arrive while one is presented (other threads) queue in FIFO order and are decided when the current one resumes.

### Coordinate mapping (`src/debug/coor.ts`)

Pure functions over the `code` string the event carries, using the reader in `src/repl/forms.ts`:

- `rangeForCoor(code, coor): FormRange | null`. Read the first form of `code`; reader prefixes such as `#dbg` and `^meta` belong to the form, so the walk starts at its base. For each index: lists and vectors index their live children (a `#_` child is not read by Clojure, so it does not count, matching `readLiveChild`). Maps: index `2i` is the `i`-th entry's key, `2i+1` its value, in source order; a map with more than 8 entries returns the map's own range (cider sorts its keys and we cannot reproduce that reliably). A `#(...)` literal reads as `(fn* [args] body)`: index 2 continues into the literal's own list, indices 0 and 1 resolve to the literal's range. `@x`, `#'x`, `'x` read as two-element lists: index 1 is the prefixed form, index 0 resolves to the whole prefixed form. Any index into an atom, string, set, syntax-quote, or reader conditional resolves to that form's range. The function returns the **deepest range it resolved**, never fails on a path that runs off the tree, and returns null only when `code` does not parse.
- `coorForLine(code, relLine): number[] | null`. For `:here`. The coordinate of the deepest-leftmost form that starts on `relLine` (relative to the code's first line): take the first form starting on that line, descend into its first child while that child also starts on the line, and stop at an atom or at a form whose children start later. Every other form on or after that line has a greater coordinate, so nothing on the target line is skipped. If no form starts on the line, use the first form (in reading order) that starts after it; null if none.

Mapping to the buffer: `docOffset = formStartOffset + (codeOffset - baseStartInCode)`, where the record supplies the form's start offset in the document and the reader supplies where the base form begins inside `code`. If the document changed since instrumentation, the record's form is re-located by its identity (`(defn foo` → find the top-level `defn foo` in the current text; for `defmethod`, the multimethod name plus the dispatch value text); if not found, the original position is used.

### Instrumentation policy

- **Auto-instrument only defn-family forms:** `defn`, `defn-`, `defmacro`, `defmethod`, `deftest`, bare or namespace-qualified head. Re-evaluating these is idempotent. A breakpoint inside any other top-level form (`def` with a side-effecting init, `defonce`, `defstate`, a bare expression) stays **unverified** with the message "Breakpoints instrument only defn/defmacro/defmethod/deftest forms; use Debug Current Top-Level Form". Nothing is evaluated for it.
- **Silent evals.** `ConnectionManager.eval(code, opts, { silent: true })` writes no `in` and no `value` entry to the transcript; `err` output is still appended so a failed instrumentation is visible in the REPL pane. The eval sends `ns` from `nsBefore` (without it the var would be defined in the REPL's current namespace and the real function would stay uninstrumented), plus `file`/`line`/`column` of the form start.
- **Records.** Per REPL session, keyed by the form's **identity**: `uri + "::" + head + " " + name`, plus `" " + dispatch` for `defmethod`, where `dispatch` is the raw text of the third live child (`(defmethod area :circle` → `defmethod area :circle`), so several methods of one multimethod never collide. Value: `{ uri, formRange, docVersion, code (the exact string sent, prefix included), kind: "breakpoints" | "dbgCommand", verified: boolean, message?: string }`. De-instrumentation re-evaluates the record's snapshot without the prefix, never the buffer's current text, so a half-edited function is never evaluated behind the user's back.
- **Verification states** (surfaced through DAP `setBreakpoints` responses and `breakpoint` events while a session runs): not connected; middleware missing; form not in the defn family; `namespace-not-found` from nREPL ("Namespace not loaded, run Evaluate File first"); eval error (first line of `err`); conditional breakpoint or logpoint (unsupported in v1, unverified with a message). Outside a session VS Code cannot draw an unverified state, so `BreakpointSync` also shows a 3-second status-bar message when a newly added breakpoint cannot be instrumented, and a one-time warning with actions when the middleware is missing (see REPL command).
- **Sync triggers.** `vscode.debug.onDidChangeBreakpoints` (debounced 300 ms), the active REPL changing, a REPL connecting (full sync) or disconnecting (records dropped, all unverified), and the eval-cooperation hook. Document edits never trigger evaluation.

### Debug session and adapter

- **Contributions.** `breakpoints: [{ language: "clojure" }]`; `debuggers: [{ type: "clojure-pulse", label: "Clojure Pulse", languages: ["clojure"], configurationAttributes: { attach: { properties: { repl: { type: "string", description: "REPL configuration name; defaults to the active REPL" } } } } }]`; command `clojurePulse.debugCurrentForm` "Debug Current Top-Level Form"; activation event `onDebugResolve:clojure-pulse`.
- **`DebugManager`** owns one `CiderBackend` per connected REPL session, the `DebugAdapterDescriptorFactory` (inline), the `DebugConfigurationProvider` (fills `repl` with the active REPL name), and the auto-start: on a "show" decision with no session for that REPL, `startDebugging(undefined, { type: "clojure-pulse", request: "attach", name: "Clojure REPL: <name>", repl: "<name>" })`. The backend keeps the current pause until the adapter attaches and sends `configurationDone`, then the adapter emits `stopped`.
- **`ClojureDebugSession`** (`DebugSession` subclass) talks only to a `DebugBackend`:
  - `initialize`: `supportsConfigurationDoneRequest`; conditional breakpoints, hovers, step back, restart, function breakpoints all false. Emits `InitializedEvent`.
  - `attach`: binds the backend named by `args.repl`; errors clearly when that REPL is not connected or lacks the middleware.
  - `setBreakpoints`: answers from `BreakpointSync.verificationFor(path, lines)`; the adapter also forwards sync changes as `BreakpointEvent("changed")`.
  - `threads`: one thread from the backend. `stackTrace`: one frame, name from the form head and name (`foo` for `(defn foo`, else `form`), `Source` from the record's path, 1-based line and column of the mapped range start. `scopes`: `Locals`. `variables`: first `(value)` = `debug-value`, then each local, all flat strings (`variablesReference: 0`).
  - `next`/`stepIn`/`stepOut`/`continue` → backend; respond immediately; the following pause arrives as `StoppedEvent` with reason `step` or `breakpoint`.
  - `evaluate` → `backend.evaluate(expression)`; the result is the follow-up event's `debug-value`, the pause position does not move, no `stopped` event is emitted, and the stored `key` is replaced.
  - `disconnect`/`terminate` → `backend.quit()`. `pause` → error "Pause is not supported; execution pauses at breakpoints".
  - Backend `onDidEnd` (REPL disconnected) → `TerminatedEvent`.
- **Inline value.** `DebugValueDecoration` owns one `after` ghost-text decoration type in the `debugTokenExpression.value` colour, rendered at the end of the paused range's last line with `formatInlineText` and `renderRange` from `src/repl/inlineResults.ts`, cleared on resume, step, and session end. VS Code's own current-line highlight comes from the stack frame; the extension draws no line highlight.

### JDI-readiness (the seam, nothing more)

`src/debug/backend.ts` defines the interface the adapter depends on. A future JDWP/JDI backend implements it with real threads and frames; the cider backend supplies exactly one of each.

```ts
export interface DebugFrame { id: number; name: string; path?: string; line: number; column: number;
  locals: Array<{ name: string; value: string }>; value?: string; }
export interface DebugThread { id: number; name: string; frames: DebugFrame[]; }
export interface PauseInfo { reason: "breakpoint" | "step"; threads: DebugThread[]; }
export interface DebugBackend {
  readonly paused: PauseInfo | undefined;
  onDidPause(listener: (pause: PauseInfo) => void): { dispose(): void };
  onDidResume(listener: () => void): { dispose(): void };
  onDidEnd(listener: () => void): { dispose(): void };
  stepOver(): void; stepInto(): void; stepOut(): void; continue(): void; quit(): void;
  evaluate(code: string): Promise<string>;
}
```

Lifetimes: a backend lives as long as its REPL connection, not as long as a VS Code debug session. `quit()` aborts the current pause (sending `:quit` if paused), drops queued pauses, and resets stepping state, but leaves the backend ready for the next break event, which auto-starts a fresh debug session. `onDidEnd` fires only when the connection is lost.

Breakpoint syncing stays outside the adapter and outside the backend interface: a JDI backend would set breakpoints directly instead of re-evaluating forms. No further abstraction.

### REPL command

- The deps default becomes
  `clojure -Sdeps '{:aliases {:clojure-pulse/nrepl {:extra-deps {nrepl/nrepl {:mvn/version "1.7.0"} cider/cider-nrepl {:mvn/version "0.62.2"}} :main-opts ["-m" "nrepl.cmdline" "--middleware" "[cider.nrepl/cider-middleware]"]}}}' -M:clojure-pulse/nrepl`
  with the same win32 double-quote escaping as today. `CIDER_NREPL_VERSION = "0.62.2"` sits beside `NREPL_VERSION` in `src/repl/replConfig.ts`.
- The lein default becomes `lein update-in :plugins conj '[cider/cider-nrepl "0.62.2"]' -- repl :headless` (win32: `"[cider/cider-nrepl \"0.62.2\"]"`), the same shape CIDER's jack-in uses; the plugin injects the middleware.
- The lgx default stays `lgx nrepl`: let-go is not a JVM, so the debugger reports itself unsupported there.
- Hints mention that cider-nrepl provides the debugger and, for deps, that aliases still compose.
- Saved commands are stored verbatim, so existing entries do not gain the middleware. When a breakpoint is set or Debug Current Top-Level Form runs against a connected REPL without the debug ops, show once per connection: `Clojure Pulse: REPL "<name>" has no cider-nrepl debug middleware.` with actions **Add to REPL Command** (enabled when `addDebugMiddleware(command)` in `src/debug/commandFix.ts` recognizes our deps shape or a `lein repl :headless` shape, rewrites the saved entry through the existing settings writer, then says "Restart the REPL to apply") and **Show Snippet** (opens an untitled document with the deps and lein snippets, for custom commands and `connect` configurations).

### Known limits (v1)

- Breakpoints bind only in code (re)evaluated through this extension; a process running stale definitions never pauses. Inherent to the nREPL approach; true for CIDER and Calva too.
- One thread, one frame. The middleware's `:stacktrace` input could fill a read-only Call Stack later.
- A pause is shown at the first *evaluated* expression at or after the breakpoint line. When control flow skips the line, the pause lands on the next evaluated expression after it. Documented.
- Every instrumented function costs one or two round trips per invocation even when no breakpoint is hit; a hot loop calling an instrumented function slows noticeably while breakpoints are set.
- No conditional breakpoints, hit counts, logpoints, function breakpoints, breakpoints in jar sources, or ClojureScript. JVM Clojure only; `.lg` files out of scope.

### Follow-ups (not in this plan)

Conditional breakpoints and hit counts client-side (evaluate the condition in the frame via `:eval`, continue when false); a read-only Call Stack from `:stacktrace`; nested variable expansion for maps and vectors; `:inspect` integration; breakpoints in jar sources.

### Testing strategy

Pure logic gets unit tests without VS Code: coordinate mapping, top-level form and child walks, the decision function, the breakpoint plan, tag injection, command rewriting, protocol parsing. Protocol plumbing is tested against `src/test/fakeNreplServer.ts`, extended with `init-debugger` (held open, with a handle to emit break events), `debug-input` (recorded, never answered), and a `describe` that advertises the debug ops. The adapter is tested by driving `handleMessage` with DAP requests against a stub backend and asserting on `onDidSendMessage`. Two integration tests run in the extension host: breakpoint sync (add a `SourceBreakpoint`, assert the fake server received a `#dbg` eval with `ns`; remove it, assert the clean eval) and auto-start (emit a break, assert a `clojure-pulse` session starts and stops). The last task is a manual end-to-end check against a real REPL with cider-nrepl.

## File Structure

Create:
- `docs/debugger-jdi-notes.md`: design and history notes for a future JDI/JDWP-based JVM debugger.
- `src/debug/protocol.ts`: typed CIDER debug messages, input encoders, and the verified findings (single source of truth for wire shapes).
- `src/debug/backend.ts`: the `DebugBackend` interface and pause/thread/frame types.
- `src/debug/decision.ts`: pure `decideOnPause` and `continueDecision`.
- `src/debug/coor.ts`: pure `rangeForCoor` and `coorForLine`.
- `src/debug/ciderBackend.ts`: `DebugBackend` over one REPL session's connection: `init-debugger` lifecycle, key tracking, decision execution, eval-in-frame correlation, pause queue.
- `src/debug/breakpointPlan.ts`: pure planning: breakpoints + document texts + records → instrument/de-instrument actions and verification states.
- `src/debug/breakpointSync.ts`: VS Code shell around the plan: listeners, debounce, silent evals, records, verification queries, user messages.
- `src/debug/injectTags.ts`: pure `injectDbgTags(text, forms)` for eval cooperation.
- `src/debug/debugAdapter.ts`: `ClojureDebugSession`, the inline DAP adapter.
- `src/debug/debugValueDecoration.ts`: ghost-text value at the paused form.
- `src/debug/debugManager.ts`: backends per REPL, adapter factory, configuration provider, auto-start, Debug Current Top-Level Form, missing-middleware messages.
- `src/debug/commandFix.ts`: pure `hasDebugMiddleware(command)` and `addDebugMiddleware(command, platform)`.
- Tests: `src/test/protocol.test.ts`, `src/test/coor.test.ts`, `src/test/decision.test.ts`, `src/test/ciderBackend.test.ts`, `src/test/breakpointPlan.test.ts`, `src/test/injectTags.test.ts`, `src/test/debugAdapter.test.ts`, `src/test/commandFix.test.ts`, `src/test/debugger.integration.test.ts`.

Modify:
- `src/nrepl/client.ts`: `sendOpen` (held-open request) and `sendNoReply` (fire-and-forget).
- `src/repl/connectionManager.ts`: `hasDebugMiddleware`, `initDebugger`, `sendDebugInput`, silent eval option.
- `src/repl/replSession.ts`: pass-through of the three debug methods on `ReplSessionLike`; update every test fake that implements it.
- `src/repl/forms.ts`: `topLevelForms`, `topLevelFormAt`, `childForms`, `formHead`.
- `src/repl/replConfig.ts`: `CIDER_NREPL_VERSION`, new deps and lein defaults, hints.
- `src/test/fakeNreplServer.ts`: debug ops.
- `src/test/nreplClient.test.ts`, `src/test/connectionManager.test.ts`, `src/test/replSession.test.ts`, `src/test/forms.test.ts`, `src/test/replConfig.test.ts`: new cases.
- `src/extension.ts`: wire `DebugManager` and `BreakpointSync`, register the command, eval cooperation, export both on the extension API for integration tests.
- `package.json`: dependencies, `breakpoints`, `debuggers`, command, activation event.
- `README.md`, `CHANGELOG.md`, `docs/plans/2026-07-18-nrepl-debugger.md` (superseded note).

---

## Stage 0: History

### Task 1: JDI notes document

**Files:**
- Create: `docs/debugger-jdi-notes.md`

- [ ] **Step 1: Write the document**
  Use /writing-clearly. Sections, each a few paragraphs or a list:
  - *Why this exists*: the debugger shipped on cider-nrepl instrumentation; a JVM-level debugger over JDWP/JDI is the possible next step; this file keeps the reasoning.
  - *What JDI would buy*: breakpoints anywhere including jars and code never re-evaluated, full stack and threads, exception breakpoints, native conditional breakpoints and hit counts, no instrumentation and no per-invocation round trips.
  - *Three architecture shapes*: (1) a self-attaching nREPL middleware using JDI against its own JVM, as the abandoned `debug-middleware` behind the "Clojure Code"/Continuum extension did around 2017, reusing our bencode client; (2) a sidecar JVM speaking DAP over stdio, cleanly isolated but a second JVM to start and a jar to ship; (3) a JDWP wire client in TypeScript, no JVM component but a far larger protocol surface than bencode. Tradeoffs for each.
  - *Clojure-specific hurdles*: a new class per re-evaluated fn, so breakpoints must re-resolve via `ClassPrepareRequest` with a source-name filter; source paths via the Clojure SMAP stratum (`SourceDebugExtension`); munged locals and closed-over values living as fields on the fn object; locals clearing nulling values after last use; printing values by invoking `pr-str` in the debuggee with `*print-length*` bound; step filters through `clojure.core`, `invokeStatic`/`invoke` trampolines and lazy sequences; the debuggee needs `-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=127.0.0.1:0` in the REPL command and a JDK (the `jdk.jdi` module) wherever JDI runs.
  - *Prior art*: Cursive (JDWP through the IntelliJ Java debugger); Microsoft `java-debug` (needs the JDT language server for source lookup, so it cannot set breakpoints in `.clj` files); Calva and CIDER (cider-nrepl, no JDI).
  - *What the current design leaves open*: the `DebugBackend` seam in `src/debug/backend.ts` (threads and frames already plural), breakpoint sync outside the adapter, and the REPL command as the place to add the jdwp flag.

- [ ] **Step 2: Commit**
  `git commit -m "docs: add JDI debugger notes for future reference"`

## Stage A: Protocol, plumbing, adapter

Milestone: **Debug Current Top-Level Form** works end to end (pause, locals, stepping, Debug Console) with no gutter involvement yet.

### Task 2: Verify the CIDER debug protocol and write `protocol.ts`

**Files:**
- Create: `src/debug/protocol.ts`
- Test: `src/test/protocol.test.ts`

- [ ] **Step 1: Verify against the source**
  Fetch `https://raw.githubusercontent.com/clojure-emacs/cider-nrepl/v0.62.2/src/cider/nrepl/middleware/debug.clj` and `.../v0.62.2/src/cider/nrepl/middleware/util/instrument.clj` (the pinned release, not master). Confirm or correct every bullet in "Verified protocol facts", and settle these specifically: (a) how `debug-input`'s `input` string is parsed (a bare `:next` keyword string vs a `{:response ...}` map, and the exact `:here` map shape and `:coord` key); (b) `coord<` ordering: confirm a parent coordinate sorts *after* its children and that nothing sorts before `[0]`; (c) whether the `:here` skip persists into the next invocation of the same function within one eval session (see "From a pause to a decision"), and therefore whether Continue-with-no-later-breakpoint needs the `:here [0]` reset step; (d) what a failing `:eval` returns (an unchanged `debug-value`, an `err` field, or a new event with an error string); (e) whether `need-debug-input` carries `session`, `original-id`, or other fields worth typing.

- [ ] **Step 2: Try an empirical probe if a JVM is available**
  Check `java -version` and `clojure --version` (the machine has mise shims; `mise use -g java@temurin-21 clojure@latest` may provision them). If both run: create `/tmp/dbgprobe/deps.edn` `{}` and start `clojure -Sdeps '{:deps {nrepl/nrepl {:mvn/version "1.7.0"} cider/cider-nrepl {:mvn/version "0.62.2"}}}' -M -m nrepl.cmdline --middleware '[cider.nrepl/cider-middleware]'` in the background. Write a throwaway Node script (not committed) using `out/nrepl/client.js` after `npm run compile-tests`: clone, describe (assert the debug ops), send `init-debugger` and log its messages, eval `#dbg (defn f [x] (let [y (inc x)] (if (odd? y) (* y 2) (- y))))`, eval `(f 1)`, then answer with `:next`, `{:response :here :coord [...]}`, `{:response :eval :code "y"}`, `:continue`, and `(dotimes [i 2] (f i))` to observe the per-invocation and skip behaviour from (c). Record the raw messages in the `protocol.ts` comment block. If no JVM is available, note that in `protocol.ts` and rely on Step 1; Task 15 re-checks empirically.

- [ ] **Step 3: Write the failing test**
  `src/test/protocol.test.ts`: `parseBreakEvent(msg)` returns a typed `BreakEvent` from a raw message (coor list of ints, locals pairs, strings) and undefined when `status` lacks `need-debug-input`; `encodeInput(...)` produces the exact EDN strings for next/in/out/continue/continue-all/quit, `here(coord)`, and `evalIn(code)` with proper string escaping in the eval code.

- [ ] **Step 4: Run the test to verify it fails**
  Run: `npm test`
  Expected: FAIL, module `../debug/protocol` not found.

- [ ] **Step 5: Implement `protocol.ts`**
  Types for the break event and inputs, the two functions, and a comment block recording every Step 1 and Step 2 finding, including corrections to this plan.

- [ ] **Step 6: Run tests**
  Run: `npm test`
  Expected: PASS.

- [ ] **Step 7: Commit**
  `git commit -m "feat: add cider debug protocol types and findings"`

### Task 3: Held-open and fire-and-forget requests in `NreplClient`

**Files:**
- Modify: `src/nrepl/client.ts`
- Test: `src/test/nreplClient.test.ts`

- [ ] **Step 1: Write the failing tests**
  `sendOpen(request, onMessage): { cancel(): void }` writes the request with a fresh `id`, calls `onMessage` for every response with that id including ones carrying `done`, never resolves or rejects anything, and `cancel()` stops routing (later messages with that id go to `onUnhandled`). Closing the socket while an open request exists must not reject into anything (no unhandled rejection) and the pending map must not keep it. `sendNoReply(request)` writes the message with an `id` and registers nothing: after many calls the client has zero pending entries (expose `pendingCount` for tests, or assert via a `send` that still resolves and the absence of leaks through the existing `onSocketClosed` behaviour).

- [ ] **Step 2: Run tests to verify they fail**
  Run: `npm test`
  Expected: FAIL, `sendOpen` is not a function.

- [ ] **Step 3: Implement**
  Keep `send()` untouched. A separate `open` map from id to handler; `dispatch` consults it before the unhandled listeners; `onSocketClosed` clears it. `sendNoReply` writes and returns.

- [ ] **Step 4: Run tests**
  Run: `npm test`
  Expected: PASS.

- [ ] **Step 5: Commit**
  `git commit -m "feat: support held-open and fire-and-forget nREPL requests"`

### Task 4: Debug ops on the connection, the session, and the fake server

**Files:**
- Modify: `src/test/fakeNreplServer.ts`, `src/repl/connectionManager.ts`, `src/repl/replSession.ts`
- Test: `src/test/connectionManager.test.ts`, `src/test/replSession.test.ts`

- [ ] **Step 1: Extend the fake server**
  `startFakeNrepl({ debugOps?: boolean })`: when set, `describe` includes `ops: { "init-debugger": {}, "debug-input": {}, eval: {}, ... }`. `init-debugger` is held open: the fake exposes `emitBreak(fields)` which writes a message with the held request's `id`, `status: ["need-debug-input"]`, and the given fields. `debug-input` is recorded in `received` and **never answered**. Keep the default handler's other behaviour.

- [ ] **Step 2: Write the failing tests**
  `ConnectionManager`: `hasDebugMiddleware` is true only when `describe` advertised `init-debugger` (false before connect and after disconnect); `initDebugger(onEvent)` sends the op once and routes each `need-debug-input` to `onEvent` as a parsed `BreakEvent`; a second call while connected is a no-op; `sendDebugInput(key, input)` writes `{op: "debug-input", key, input}` and leaves no pending request after 50 sends; disconnecting cancels the open request without errors. `eval(code, opts, { silent: true })` appends no `in` and no `value` entry but still appends `err`. `ReplSession` forwards `hasDebugMiddleware`, `initDebugger`, `sendDebugInput` and the silent option; update every test fake implementing `ReplSessionLike`.

- [ ] **Step 3: Run tests to verify they fail**
  Run: `npm test`
  Expected: FAIL, missing members.

- [ ] **Step 4: Implement**
  Store the described `ops` on the active connection. `initDebugger` uses `sendOpen`; `sendDebugInput` uses `sendNoReply`. Add the silent branch to `collectEvalMessage`/`eval`. Extend `ReplSessionLike` and `ReplSession`.

- [ ] **Step 5: Run tests**
  Run: `npm test`
  Expected: PASS.

- [ ] **Step 6: Commit**
  `git commit -m "feat: expose cider debug ops on the REPL connection"`

### Task 5: Top-level form and child lookup in the reader

**Files:**
- Modify: `src/repl/forms.ts`
- Test: `src/test/forms.test.ts`

- [ ] **Step 1: Write the failing tests**
  - `topLevelForms(text): TopLevelForm[]` in buffer order, each `{ range (leading #_ stripped, as formAtCursor does), head?: string, name?: string, dispatch?: string }` where `head` is the bare head token without namespace (`t/deftest` → `deftest`), `name` is the second live child when it is a symbol, and `dispatch` is the raw text of the third live child when `head` is `defmethod` (`:circle`, `[:a :b]`, `String`). Unbalanced tails yield the forms before them.
  - `topLevelFormAt(text, offset): TopLevelForm | null`: the top-level form whose range contains `offset` (start ≤ offset ≤ end), never a neighbour.
  - `childForms(text, range): ChildForm[]` for a bracketed form: the live children in order (a `#_` child skipped, `^meta` attached to its form, reader prefixes attached), each `{ range, baseStart, bracket: "(" | "[" | "{" | null, prefix: string }` where `prefix` is the raw prefix text (`""`, `"#"`, `"@"`, `"'"`, `"#'"`, `"#dbg "`). Strings, chars, and regexes count as atoms.
  - `formHead(text, range): string | undefined`: bare head token of a list form.
  Cover comments, strings with brackets, `#_`, metadata, `#()`, `#{}`, `#?()`, and quoted forms.

- [ ] **Step 2: Run tests to verify they fail**
  Run: `npm test`
  Expected: FAIL.

- [ ] **Step 3: Implement as thin exports over `readForm`/`readLiveChild`**
  Do not duplicate the reader. `resolveDeftest` can reuse `formHead`.

- [ ] **Step 4: Run tests**
  Run: `npm test`
  Expected: PASS.

- [ ] **Step 5: Commit**
  `git commit -m "feat: expose top-level and child form walks in the forms reader"`

### Task 6: Coordinate mapping

**Files:**
- Create: `src/debug/coor.ts`
- Test: `src/test/coor.test.ts`

- [ ] **Step 1: Write the failing tests**
  `rangeForCoor` per "Coordinate mapping": list/vector children by index including the head; nested paths; a `#_` child not counted; `^meta` not counted; maps by `2i`/`2i+1` in source order and a 9-entry map resolving to the map itself; `#(...)` index 2 descending into the literal and index 1 resolving to the literal; `@x` and `'x` index 1; a path that runs off the tree returns the deepest resolved range; code starting with `#dbg ` maps into the base form; unparsable code returns null. `coorForLine`: deepest-leftmost form on a line (`(when (valid? x)` on line 2 → the coordinate of `when`), a line whose only form is a nested argument, a line with no form falling to the next form after it, and null past the end.

- [ ] **Step 2: Run tests to verify they fail**
  Run: `npm test`
  Expected: FAIL.

- [ ] **Step 3: Implement with Task 5's `childForms`**
  Detect `#(` by `prefix === "#"` and `bracket === "("`; detect `@`, `'`, `` ` ``, `#'` by prefix. Line numbers inside `code` count `\n` from its start.

- [ ] **Step 4: Run tests**
  Run: `npm test`
  Expected: PASS.

- [ ] **Step 5: Commit**
  `git commit -m "feat: map cider debug coordinates to source ranges"`

### Task 7: Decision function and `CiderBackend`

**Files:**
- Create: `src/debug/backend.ts`, `src/debug/decision.ts`, `src/debug/ciderBackend.ts`
- Test: `src/test/decision.test.ts`, `src/test/ciderBackend.test.ts`

- [ ] **Step 1: Write the failing decision tests**
  One test per rule in "From a pause to a decision", plus: two breakpoints in one form (first pause before both → here to the first; after Continue at the first → here to the second; at the second → continue); a loop whose pause line drops below the target after a `:here` (rule 6 again); `dbgCommand` always shows; stepping shows with reason `step`; `continueDecision(currentPause, breakpointLines, resetBeforeContinue)` returning `here`, `continue`, or the two-step reset sequence when the flag from Task 2 is on.

- [ ] **Step 2: Write the failing backend tests**
  Against a stub session exposing `initDebugger`/`sendDebugInput` (no socket needed) and a stub `PauseContext` provider returning `{ kind, uri, formStartLine, breakpointLines, code }` for a `file`+`line`+`code`: a break event whose decision is `show` becomes one `PauseInfo` with one thread, one frame (name from head + name, path, mapped 1-based line/column, `(value)` then locals); a `here` decision sends `debug-input` with the encoded `:here` map and the coordinate from `coorForLine` and emits nothing; mapping failure sends `:next`; `stepOver` sends `:next` with the current key and the next event shows with reason `step`; `continue` sends `:here`/`:continue` per `continueDecision`; `evaluate("y")` sends the `:eval` input and resolves with the follow-up event's `debug-value`, replaces the key, emits no pause; a second event while paused queues and is decided after resume; `quit` sends `:quit` when paused, drops the queue, resets to auto mode, and keeps the backend usable: a break event arriving afterwards is decided and emitted normally; only the connection dropping emits `onDidEnd`; an event with no matching record is `kind: "unknown"` and shows at the event's own `file`/`line`.

- [ ] **Step 3: Run tests to verify they fail**
  Run: `npm test`
  Expected: FAIL.

- [ ] **Step 4: Implement**
  `backend.ts` exactly as in "JDI-readiness". `decision.ts` pure. `ciderBackend.ts` holds `key`, `mode`, `lastAction`, `hereTargetLine`, `pendingEval`, the queue, and the `PauseContext` provider injected by the manager (Task 9 wires `BreakpointSync` into it; until then the provider comes from the Debug Current Top-Level Form records).

- [ ] **Step 5: Run tests**
  Run: `npm test`
  Expected: PASS.

- [ ] **Step 6: Commit**
  `git commit -m "feat: add cider debug backend with pause decision logic"`

### Task 8: The inline DAP adapter

**Files:**
- Create: `src/debug/debugAdapter.ts`
- Modify: `package.json` (dependencies `@vscode/debugadapter` and `@vscode/debugprotocol` `^1.68.0`)
- Test: `src/test/debugAdapter.test.ts`

- [ ] **Step 1: Install the dependencies**
  Run: `npm install @vscode/debugadapter@^1.68.0 @vscode/debugprotocol@^1.68.0`
  Expected: both under `dependencies` in `package.json`; `npm run compile` still succeeds (esbuild bundles them).

- [ ] **Step 2: Write the failing tests**
  Drive `ClojureDebugSession` through `handleMessage` with a stub `DebugBackend` and a stub `verificationFor`, collecting `onDidSendMessage` output: `initialize` capabilities as in "Debug session and adapter" and an `initialized` event; `attach` with an unknown `repl` responds with an error; `configurationDone` followed by a backend pause emits `stopped` with the right reason and `threadId`; a pause that arrived *before* `configurationDone` is emitted right after it; `threads`, `stackTrace` (one frame, 1-based line and column, source path), `scopes`, `variables` (`(value)` first, then locals); `next`/`stepIn`/`stepOut`/`continue` call the backend and respond; `evaluate` returns the backend's result; `pause` errors; `disconnect` calls `quit` and unsubscribes the adapter from the backend, so a pause after the session ended is not delivered to a dead adapter; backend end emits `terminated`; `setBreakpoints` echoes `verificationFor` results with `verified`, `line`, `message`.

- [ ] **Step 3: Run tests to verify they fail**
  Run: `npm test`
  Expected: FAIL.

- [ ] **Step 4: Implement**
  Subclass `DebugSession` from `@vscode/debugadapter`; constructor takes `{ backendFor(repl): DebugBackend | undefined, verificationFor(path, lines) }`. Set `setDebuggerLinesStartAt1(true)` and `setDebuggerColumnsStartAt1(true)`; frames carry 1-based values.

- [ ] **Step 5: Run tests**
  Run: `npm test`
  Expected: PASS.

- [ ] **Step 6: Commit**
  `git commit -m "feat: add inline debug adapter over the debug backend"`

### Task 9: `DebugManager`, contributions, Debug Current Top-Level Form

**Files:**
- Create: `src/debug/debugManager.ts`, `src/debug/debugValueDecoration.ts`
- Modify: `package.json`, `src/extension.ts`
- Test: `src/test/debugger.integration.test.ts`

- [ ] **Step 1: package.json contributions**
  Add `breakpoints`, `debuggers`, the `clojurePulse.debugCurrentForm` command ("Debug Current Top-Level Form", category "Clojure Pulse"), and the `onDebugResolve:clojure-pulse` activation event, as specified in "Debug session and adapter". Add a `commandPalette` `when` of `editorLangId == clojure` if the existing eval commands use one; otherwise leave it unrestricted like them.

- [ ] **Step 2: Write the failing integration test**
  In `debugger.integration.test.ts`, following `replCommands.integration.test.ts`: configure a `connect` REPL against a fake server started with `debugOps: true`, connect through the extension API, assert the fake received `init-debugger`. Run `clojurePulse.debugCurrentForm` on a temp `.clj` document with the cursor in `(defn f [x] (inc x))`: assert the fake received an `eval` whose `code` starts with `#dbg (defn f` and carries `ns`, `file`, `line`, `column`. Then `emitBreak` with that `code`, `coor: [3 1]`, `key`, `debug-value: "1"`, `locals: [["x", "1"]]`, `file`, `line`: assert `vscode.debug.onDidStartDebugSession` fires with type `clojure-pulse`, and `vscode.debug.activeDebugSession` exists; run `workbench.action.debug.stop` and assert the fake received `debug-input` with `:quit` and the session ended. Then `emitBreak` again with a fresh `key` and assert a second `clojure-pulse` session starts: the backend outlives the debug session.

- [ ] **Step 3: Run the test to verify it fails**
  Run: `npm test`
  Expected: FAIL.

- [ ] **Step 4: Implement**
  `DebugManager({ registry, inlineValue: DebugValueDecoration, pauseContext, onMissingMiddleware })`: watches `registry.onDidChange` and each session's state; on `connected` with `hasDebugMiddleware` creates a `CiderBackend` and calls `initDebugger`; on `stopped` disposes it. Registers the factory (`DebugAdapterInlineImplementation(new ClojureDebugSession(...))`), the configuration provider (`resolveDebugConfiguration` fills `type`, `request: "attach"`, `name`, `repl` from the active REPL), and the auto-start on any `onDidPause` while no `clojure-pulse` session for that REPL is alive (sessions come and go; the backend lives as long as the connection, so stopping a session and hitting the breakpoint again starts a new one). `debugCurrentForm`: `topLevelFormAt` at the cursor (any head), `runEval` with `#dbg ` + text, `ns` from `nsBefore`, source params of the form start; records `{ kind: "dbgCommand", code, uri, formRange, docVersion }` in the manager's own record map (Task 11 moves records into `BreakpointSync`). When the active REPL lacks the middleware, call `onMissingMiddleware(session)` (a plain warning until Task 14 adds the actions). `DebugValueDecoration` shows on pause, clears on resume/end. Wire everything in `setupRepl`, push disposables, and export `debug` on the extension API.

- [ ] **Step 5: Run the full suite and lint**
  Run: `npm test`
  Expected: PASS.

- [ ] **Step 6: Commit**
  `git commit -m "feat: wire the Clojure debugger and Debug Current Top-Level Form"`

## Stage B: Gutter breakpoints

Milestone and release: gutter breakpoints instrument, verify, pause, and survive reloads; the default REPL command ships the middleware.

### Task 10: Breakpoint plan (pure)

**Files:**
- Create: `src/debug/breakpointPlan.ts`
- Test: `src/test/breakpointPlan.test.ts`

- [ ] **Step 1: Write the failing tests**
  `planBreakpoints({ breakpoints: Array<{ uri, line, enabled, conditional }>, texts: Map<uri, string>, records: Record[], connected: boolean, hasMiddleware: boolean }): { instrument: Array<{ uri, form: TopLevelForm, text }>, deinstrument: Record[], verification: Map<breakpointId, { verified: boolean; message?: string; line?: number }> }`. Cases: first breakpoint in a `defn` → one instrument action with the form's text; a second breakpoint in the same form → no action; last breakpoint removed → deinstrument the record; a breakpoint in a `def` or `defonce` → unverified with the defn-family message, no action; a disabled breakpoint counts as absent; a conditional breakpoint → unverified with the unsupported message; not connected or no middleware → everything unverified, no actions; a breakpoint on a blank line between forms → unverified "no form at this line"; `t/deftest` and `clojure.test/deftest` count as defn-family; two `defmethod` forms of the same multimethod with a breakpoint in each produce two records and two instrument actions, and removing the breakpoint from one de-instruments only that method; a record whose form is no longer found in the current text is left alone (server state is unchanged) and its breakpoints stay verified.

- [ ] **Step 2: Run tests to verify they fail**
  Run: `npm test`
  Expected: FAIL.

- [ ] **Step 3: Implement**
  Group by `topLevelFormAt(text, offsetOfLine)`; record key as defined under "Records" (head, name, and the dispatch value for `defmethod`).

- [ ] **Step 4: Run tests**
  Run: `npm test`
  Expected: PASS.

- [ ] **Step 5: Commit**
  `git commit -m "feat: plan breakpoint instrumentation from editor breakpoints"`

### Task 11: `BreakpointSync`

**Files:**
- Create: `src/debug/breakpointSync.ts`
- Modify: `src/debug/debugManager.ts`, `src/debug/ciderBackend.ts` (if the `PauseContext` shape needs adjusting), `src/extension.ts`
- Test: `src/test/debugger.integration.test.ts`

- [ ] **Step 1: Write the failing integration test**
  With the fake debug server connected: `vscode.debug.addBreakpoints([new SourceBreakpoint(new Location(uri, new Position(1, 0)))])` inside a `defn` in a temp file → within a second the fake receives an `eval` whose `code` is `#dbg ` + the form text, with `ns` from the file's `ns` form and `file`/`line`/`column` of the form start, and the transcript has no `in` entry for it. `removeBreakpoints` → the fake receives the same form text without the prefix. A breakpoint inside `(def state (atom {}))` → no eval within the debounce window and `verificationFor(path, [line])` reports unverified with the defn-family message. After `emitBreak` for the instrumented code with a `coor` that maps to the breakpoint line, a debug session starts (reusing Task 9's assertions).

- [ ] **Step 2: Run the test to verify it fails**
  Run: `npm test`
  Expected: FAIL.

- [ ] **Step 3: Implement**
  `BreakpointSync({ registry, openText(uri): Promise<string | undefined>, now })`: subscribes to `onDidChangeBreakpoints`, `registry.onDidChange`, and each session's state; debounces 300 ms; serializes runs per REPL; runs `planBreakpoints`; executes actions through `session.eval(code, { ns, file, line, column }, { silent: true })`; on success stores or removes records; on `namespaceNotFound` or `err` marks the breakpoints unverified with the message and drops the record. Only `file:` URIs are considered. Exposes `verificationFor(path, lines)`, `onDidChangeVerification`, `pauseContextFor(event)` (record by exact `code`, else by path + form start line, else undefined) including the re-location by head and name, and for Task 13 `targetedForms(uri, text)` (defn-family top-level forms with enabled breakpoints) and `noteInstrumented(uri, tagged)`. Status-bar message for a newly unverifiable breakpoint; `onMissingMiddleware` when the active REPL lacks the ops. Move the `dbgCommand` records from `DebugManager` into the sync so one map serves both. Export `breakpointSync` on the extension API.

- [ ] **Step 4: Run tests**
  Run: `npm test`
  Expected: PASS.

- [ ] **Step 5: Commit**
  `git commit -m "feat: instrument breakpointed forms from gutter breakpoints"`

### Task 12: Verification through the adapter

**Files:**
- Modify: `src/debug/debugAdapter.ts`, `src/debug/debugManager.ts`
- Test: `src/test/debugAdapter.test.ts`

- [ ] **Step 1: Write the failing test**
  When the sync's `onDidChangeVerification` fires for a path with breakpoints during a session, the adapter emits a `breakpoint` event (`reason: "changed"`) per affected breakpoint with the new `verified` and `message`. `setBreakpoints` for a path with no records answers unverified with the sync's reasons.

- [ ] **Step 2: Run the test to verify it fails**
  Run: `npm test`
  Expected: FAIL.

- [ ] **Step 3: Implement**
  The adapter keeps the DAP breakpoint ids it handed out per path and subscribes to the sync while the session lives.

- [ ] **Step 4: Run tests**
  Run: `npm test`
  Expected: PASS.

- [ ] **Step 5: Commit**
  `git commit -m "feat: report breakpoint verification changes to the debug UI"`

### Task 13: Eval commands keep breakpointed forms instrumented

**Files:**
- Create: `src/debug/injectTags.ts`
- Modify: `src/extension.ts`
- Test: `src/test/injectTags.test.ts`, `src/test/debugger.integration.test.ts`

- [ ] **Step 1: Write the failing tests**
  `injectDbgTags(text, ranges): { text, tagged: Array<{ range, code }> }` inserts `#dbg ` before each given top-level range (sorted, offsets adjusted), adds no newlines, leaves everything else byte-identical, and returns per form the exact code string the server will read (prefix plus form text). Integration: with a breakpoint in `defn f`, Evaluate File sends a `load-file` whose `file` text contains `#dbg (defn f` and leaves `(defn g` untagged; Evaluate Current Form with the cursor inside `f` sends `#dbg (defn f ...` as `code`; Evaluate Current Form on an inner expression of `f` sends it unchanged; after each, `pauseContextFor` finds the record by the new code string.

- [ ] **Step 2: Run tests to verify they fail**
  Run: `npm test`
  Expected: FAIL.

- [ ] **Step 3: Implement**
  Route the three `load-file` call sites (`evalFile`, `runTestAtCursor`, `runNsTests`) through one `loadDocument(session, doc)` helper in `extension.ts` that asks `breakpointSync.targetedForms(uri, text)` (defn-family forms with enabled breakpoints), injects, loads, and on success calls `noteInstrumented`. In `evalCurrentForm`, when the resolved range equals a targeted top-level form, prefix the code and note it. `evalSelection` is untouched.

- [ ] **Step 4: Run tests**
  Run: `npm test`
  Expected: PASS.

- [ ] **Step 5: Commit**
  `git commit -m "feat: keep breakpointed forms instrumented across evaluations"`

### Task 14: cider-nrepl in the default REPL command, and the fix-up flow

**Files:**
- Create: `src/debug/commandFix.ts`
- Modify: `src/repl/replConfig.ts`, `src/debug/debugManager.ts`, `src/extension.ts`, `README.md`
- Test: `src/test/replConfig.test.ts`, `src/test/commandFix.test.ts`

- [ ] **Step 1: Write the failing tests**
  `replConfig.test.ts`: the deps default on POSIX equals the exact string in "REPL command"; win32 escapes every inner quote and contains `--middleware`; lein default equals the `update-in` form on POSIX and uses escaped double quotes on win32; lgx unchanged; hints mention the debugger. `commandFix.test.ts`: `hasDebugMiddleware(command)` is true when the command mentions `cider-nrepl`; `addDebugMiddleware(oldDepsDefault, "linux")` yields the new deps default; a deps command with extra aliases in `-M:dev:clojure-pulse/nrepl` keeps them; `lein repl :headless` and `lein with-profile +dev repl :headless` gain the `update-in :plugins conj` prefix; a command already containing `cider-nrepl` returns undefined; an unrecognized command (`make repl`, `bb nrepl`) returns undefined.

- [ ] **Step 2: Run tests to verify they fail**
  Run: `npm test`
  Expected: FAIL.

- [ ] **Step 3: Implement**
  `CIDER_NREPL_VERSION` beside `NREPL_VERSION`; build both defaults from it. `commandFix.ts` pure. In `DebugManager.onMissingMiddleware`: a warning once per connection with **Add to REPL Command** (only for `create` configs where `addDebugMiddleware` returns a string; rewrites the entry via the existing `rawReplConfigurations`/`writeReplConfigurations` pair and `upsertEntry`, then an info message "Restart the REPL to apply") and **Show Snippet** (opens an untitled `clojure` document with the deps and lein snippets and a one-line explanation). Update the README's two command snippets (lines ~309 and ~345) and the "create" prose to say the command includes cider-nrepl for the debugger.

- [ ] **Step 4: Run tests**
  Run: `npm test`
  Expected: PASS.

- [ ] **Step 5: Commit**
  `git commit -m "feat: include cider-nrepl in default REPL commands with a fix-up flow"`

### Task 15: Manual end-to-end verification and docs

**Files:**
- Modify: `README.md`, `CHANGELOG.md`, `docs/plans/2026-07-18-nrepl-debugger.md`

- [ ] **Step 1: Manual end-to-end against a real REPL**
  In a sample deps.edn project, add a `create` REPL with the new default command and start it from the REPL view (first run downloads cider-nrepl). In the Extension Development Host: set a gutter breakpoint inside a `defn`; call the function from the REPL pane; confirm the session auto-starts, the editor pauses at the breakpoint with `(value)` and locals in Variables, and the inline value shows. Step Over, Into, Out; evaluate a local in the Debug Console; Continue. Put two breakpoints in one function and confirm Continue reaches the second. Call the function in a `dotimes` of 3 and confirm each call pauses once (this checks the Task 2 `:here` decision). Remove the breakpoint and confirm the next call does not pause. Run Evaluate File and confirm the breakpoint still pauses. Set a breakpoint in a `def` and confirm the status-bar message. Connect to a plain nREPL (no middleware) and confirm the warning with **Add to REPL Command** rewrites the saved command. Try Debug Current Top-Level Form on a bare expression. Fix what fails; record any protocol corrections in `protocol.ts`.

- [ ] **Step 2: Document**
  README: a **Debugger** feature bullet and a `## Debugging` section after `## REPL`: the gutter workflow, what the default command adds and the lein/connect snippets, `#dbg`/`#break` typed in source and Debug Current Top-Level Form, the pause semantics ("pauses at the first expression evaluated on or after the breakpoint line, with its value"), the defn-family rule, the "code must be evaluated through the REPL" limit, and the round-trip cost note. Add the new command to the Commands list. CHANGELOG under `## [Unreleased]`: the debugger, the changed default commands, and the fix-up action. Add a first line to `docs/plans/2026-07-18-nrepl-debugger.md`: `> Superseded by docs/plans/2026-09-02-2250-nrepl-debugger-gutter-breakpoints.md (whole-form #dbg instrumentation instead of per-line #break injection).`

- [ ] **Step 3: Full suite**
  Run: `npm test`
  Expected: PASS.

- [ ] **Step 4: Commit**
  `git commit -m "docs: document the nREPL debugger with gutter breakpoints"`
