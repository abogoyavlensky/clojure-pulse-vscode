# Reload Changed Namespaces Before Tests (clj-reload) Implementation Plan

**Status: complete** (except Task 6 Step 3, let-go, which this machine cannot run - see the summary).

> **For agentic workers:** Use executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every test command (Run Test at Cursor, Run Tests in Namespace, Run Last Test Command) first saves dirty Clojure files and reloads changed namespaces through [clj-reload](https://github.com/tonsky/clj-reload) when it is on the REPL's classpath, so the code you just edited is what the test exercises.

**Tech Stack:** TypeScript VS Code extension, nREPL over bencode, mocha (tdd ui) via `@vscode/test-cli` with the fake nREPL server in `src/test/fakeNreplServer.ts`; clj-reload 1.0.0 on the JVM; manual checks against a scratch deps.edn project and let-go (`~/Projects/let-go/lg`).

---

## Design

### The problem

The Cursive workflow the test commands copy is: run a test, switch to the
business-logic file, change something, re-run the test. Today the middle
step needs a manual eval of the changed file (or Evaluate File); the test
commands only ever load the *test* buffer, and Run Last Test Command
explicitly decided "no auto-reload of business logic"
(`docs/plans/2026-08-05-0038-rerun-last-test-command.md`, decision 5). This
plan supersedes that decision.

### Approach

Both document-centric test cores in `src/extension.ts` (`runSingleTest`,
`runTestsInDocument`) get one new step, placed right after they locate what
to run and start the status-bar spinner, before any nREPL traffic they send
today:

1. **Save** every dirty Clojure document in the window (`file:` scheme,
   language id `clojure`) with `doc.save()`. clj-reload reads from disk.
2. **Reload** by evaluating one expression in the active session. It calls
   `clj-reload.core/reload` with `{:throw false}` when the namespace is
   loaded, and returns a small map the extension can read without parsing a
   printed Throwable.
3. **Branch** on the result:
   - reloaded → continue exactly as today (find-ns probe, auto load-file,
     re-eval the deftest, run).
   - failed → abort the run with a notification and clear the spinner.
   - unavailable (clj-reload not on the classpath, or a runtime whose
     `resolve` misbehaves) → continue as today; a status-bar message says
     tests run without reloading, once per session connection.

Run Last Test Command inherits all of it because it calls the same cores.

A setting turns the step off: `clojurePulse.test.reloadBeforeRun`, enum
`"clj-reload"` (default) | `"none"`. With `"none"` nothing at all happens —
no save, no eval, no connect-time priming.

### Why clj-reload, and what the extension does not do

clj-reload only reloads namespaces that are already loaded and whose files
changed on disk, plus their dependents, in dependency order; `defonce` vars
survive; per-namespace `before-ns-unload` / `after-ns-reload` hooks let a
project restart only the state that depends on what changed. It has no
library dependencies and auto-initializes at `require` time by scanning every
directory on the classpath, so a project needs no configuration.

The extension deliberately assumes nothing about the project:

- It calls plain `reload`, never a project's own wrapper such as a
  `user/reset` that stops and restarts an Integrant or Component system.
  Restarting a system before every test run is not what the user wants; a
  project that needs state to follow reloads uses clj-reload's hooks, which
  fire inside `reload` and therefore work with the extension unchanged.
- It never calls `init`. A user's own `init` (with `:no-unload`,
  `:no-reload`, `:output`) in `user.clj` wins, because `require` of an
  already-loaded namespace is a no-op.
- It never adds the dependency to a JVM behind the user's back. The
  prefilled Clojure CLI command in the REPL form gains the dep explicitly,
  next to nrepl, where the user can see and remove it. Existing saved
  commands are untouched; the README says what to add.

### Reload expression

Defined once in `src/repl/testReload.ts` as `RELOAD_EXPR`:

```clojure
(if-let [f (resolve 'clj-reload.core/reload)]
  (let [r (f {:throw false})]
    (if-some [ex (:exception r)]
      {:failed (:failed r)
       :message (str (ex-message ex) (some->> (ex-cause ex) ex-message (str ": ")))}
      {:loaded (count (:loaded r))}))
  :clojure-pulse/no-reload)
```

- The `resolve` guard is the trick `runTestVar` already uses for
  `clojure.test/run-test-var`: no direct reference to a namespace that may
  not exist, so the form compiles on let-go too.
- `:message` is the load failure's first line plus its cause (a compile
  error's message is "Syntax error compiling at (file:line:col)." and the
  useful part is in the cause). clj-reload itself prints the full exception
  to `*out*`, which streams to the REPL output channel, so the notification
  can stay short.

Parsing is a small pure function, `parseReloadOutcome(outcome: EvalOutcome)`:

```ts
export type ReloadResult =
  | { kind: "unavailable" }
  | { kind: "reloaded"; loaded: number }
  | { kind: "failed"; ns: string; message: string };
```

- `outcome.err` defined → `unavailable` (the probe itself broke; with
  `:throw false` a real reload failure never comes back as `err`).
- value `:clojure-pulse/no-reload` → `unavailable`.
- value containing `:failed` → `failed`, with `ns` read from `:failed <sym>`
  and `message` from `:message "<string>"` (unescape `\"` and `\\`; on a
  value the regexes cannot read, fall back to `ns: "?"` and the raw value).
- otherwise `reloaded` with `loaded` from `:loaded <n>` (0 when absent).

### Priming on connect

clj-reload's change baseline is the moment `clj-reload.core` is first
required (it records file mtimes then). So the extension requires it as soon
as a session reaches `connected`, when the setting is `"clj-reload"`:

```clojure
(try (require 'clj-reload.core) (catch Exception _ nil))
```

The `try` keeps a missing dependency from writing a stack trace to the REPL
output on every connect. The outcome is ignored. The hook lives in
`src/extension.ts`, in the registry's `createSession` callback, via
`session.onDidChangeState`. nREPL serializes evals on one session, so a test
command sent right after connect still runs after the prime.

Known limit, documented: for a `connect` REPL the user started themselves,
files edited between JVM start and the extension's connect are missed. The
fix is `(require 'clj-reload.core)` in the project's `user.clj`.

### Error handling and feedback

| Situation | Behavior |
| --- | --- |
| Reload fails (compile error in a changed file) | `reportRunError` notification: `reload failed in <ns>: <message>`; spinner cleared; the single-test inline decoration (when an editor shows the test) is resolved with the message as an error, like today's auto-load failure. No test runs. |
| clj-reload unavailable | Run continues. `setStatusBarMessage("Clojure Pulse: clj-reload is not on the REPL classpath — tests run without reloading", 4000)`, once per connection. A session object survives stop/start (`ReplSession.start` restarts a stopped session in place; the registry only replaces it when its config changed), so "once" is tracked in a module-level `Set<ReplSessionLike>` of sessions already warned that the connect-time state listener (Task 4) *removes the session from* every time it reaches `connected`. Restarting a REPL with the dep added therefore stops the warning; restarting without it warns once more. |
| A dirty document's `save()` returns false | Ignored; the run continues with what is on disk. |
| Setting `"none"` | The step is skipped entirely, including the connect-time prime. |
| Eval throws (connection dropped mid-run) | Falls into the cores' existing `catch` → `reportEvalError`. |

### Command template and docs

`defaultCreateCommand` for `deps` projects becomes:

```
clojure -Sdeps '{:aliases {:clojure-pulse/nrepl {:extra-deps {nrepl/nrepl {:mvn/version "1.7.0"} io.github.tonsky/clj-reload {:mvn/version "1.0.0"}} :main-opts ["-m" "nrepl.cmdline"]}}}' -M:clojure-pulse/nrepl
```

with `CLJ_RELOAD_VERSION = "1.0.0"` beside `NREPL_VERSION`. `lein repl
:headless` and `lgx nrepl` are unchanged; the README tells lein users to add
the dep to their `:dev` profile.

### Testing strategy

- **Unit** (`src/test/testReload.test.ts`): `parseReloadOutcome` over the
  value shapes above, including an escaped quote in the message and an
  `err` outcome.
- **Integration** (`src/test/replCommands.integration.test.ts`, fake nREPL):
  - The existing op-order assertions for `runTestAtCursor`, `runNsTests` and
    `rerunLastTest` gain the leading reload `eval` (its `code` contains
    `clj-reload.core/reload`). The fake server's default eval reply is fine
    for it: any value without `:failed` reads as reloaded.
  - New: a reply of `{:failed app.core :message "Syntax error..."}` to the
    reload eval → no further `eval`/`load-file`, spinner cleared, status bar
    shows no running item.
  - New: `:clojure-pulse/no-reload` reply → the run proceeds (the runner
    eval is sent).
  - New: setting `"none"` → no eval whose code mentions `clj-reload`.
  - New: a dirty untitled-turned-file document is saved before the reload
    eval (write a temp `.clj`, open it, edit it, run, assert `isDirty` is
    false when the reload message arrives).
  - New: connecting sends the prime eval (code contains
    `require 'clj-reload.core`) once, and not at all with `"none"`; a
    stop/start of the same REPL re-arms the one-time "no clj-reload" hint.
  - The shared `connect(server)` helper absorbs the prime: it waits for the
    prime eval, then empties `server.received`, so the many existing
    "sends nothing" and "first eval" assertions stay as they are.
- **Manual** (final task): a scratch deps.edn project on the JVM with
  clj-reload on the classpath (edit a helper, run the test, see the new
  behavior; introduce a syntax error, see the notification), and let-go via
  `lgx nrepl` or `~/Projects/let-go/lg`, confirming the reload probe returns
  the keyword there rather than erroring.

## File Structure

- Create `src/repl/testReload.ts` — `RELOAD_EXPR`, `PRIME_EXPR`,
  `ReloadResult`, `parseReloadOutcome`. Pure; no `vscode` import.
- Create `src/test/testReload.test.ts` — unit tests for the parser.
- Modify `src/extension.ts` — `reloadSetting()`, `saveDirtyClojureDocuments()`,
  `reloadBeforeTests(session): Promise<ReloadResult | undefined>`, the two
  cores, the connect-time prime in `createSession`.
- Modify `src/repl/replConfig.ts` — `CLJ_RELOAD_VERSION`, template.
- Modify `src/test/replConfig.test.ts` — template assertions.
- Modify `src/test/replCommands.integration.test.ts` — op orders, new tests.
- Modify `package.json` — the setting; template strings in
  `replConfigurations` docs and default example.
- Modify `README.md`, `CHANGELOG.md`.
- Modify `docs/plans/2026-08-05-0038-rerun-last-test-command.md` — a one-line
  note under decision 5 pointing here.

## Tasks

### Task 1: Reload expression and parser

**Files:**
- Create: `src/repl/testReload.ts`
- Test: `src/test/testReload.test.ts`

- [x] **Step 1: Write the failing tests**
  In `src/test/testReload.test.ts` (mocha tdd, like `src/test/testStatusBar.test.ts`), cover `parseReloadOutcome`:
  - `{ value: ":clojure-pulse/no-reload", namespaceNotFound: false }` → `{ kind: "unavailable" }`.
  - `{ err: "Unable to resolve symbol", namespaceNotFound: false }` → `unavailable`.
  - `{ value: "{:loaded 3}" }` → `{ kind: "reloaded", loaded: 3 }`; `{ value: "{:loaded 0}" }` → `loaded: 0`; `{ value: "nil" }` → `reloaded`, `loaded: 0`.
  - `{ value: '{:failed app.core, :message "Syntax error compiling at (src/app/core.clj:3:1).: Unable to resolve symbol: x in this context"}' }` → `failed`, `ns: "app.core"`, message as given.
  - A message with an escaped quote (`"expected \\"x\\""`) is unescaped.
  - `{ value: "{:failed app.core}" }` (no message) → `failed` with `message: "{:failed app.core}"` and `ns: "app.core"`.
  Also assert `RELOAD_EXPR` contains `(resolve 'clj-reload.core/reload)` and `{:throw false}`, and `PRIME_EXPR` contains `(require 'clj-reload.core)` — cheap guards against a refactor changing what the integration tests grep for.

- [x] **Step 2: Run the tests to verify they fail**
  Run: `npm test -- --grep "testReload"` (or `npm run compile-tests && npx vscode-test --grep testReload`)
  Expected: FAIL — module `../repl/testReload` not found.

- [x] **Step 3: Implement `src/repl/testReload.ts`**
  Export `RELOAD_EXPR` (the exact expression from the Design, as one line), `PRIME_EXPR`, `ReloadResult`, and `parseReloadOutcome(outcome: EvalOutcome): ReloadResult` per the parsing rules in the Design. Import `EvalOutcome` from `./connectionManager`. Keep the module free of `vscode`.

- [x] **Step 4: Run the tests to verify they pass**
  Run: `npm test -- --grep "testReload"`
  Expected: PASS.

- [x] **Step 5: Commit**
  `git commit -m "Add clj-reload reload expression and outcome parser"`

> Deviation: `RELOAD_EXPR` also wraps the reload call in `(try … (catch Exception e {:failed nil :message …}))`.
> `{:throw false}` only converts *namespace load* failures into the result map; clj-reload still throws out of
> its own scan when a changed file cannot be read, which would have come back as `err` and read as "unavailable",
> letting tests run against stale code. `:failed nil` parses to `ns: "?"`.

### Task 2: Setting and command template

**Files:**
- Modify: `package.json`
- Modify: `src/repl/replConfig.ts`
- Test: `src/test/replConfig.test.ts`

- [x] **Step 1: Update the template test**
  In `src/test/replConfig.test.ts` (around line 225 and 232), change the expected deps-CLI command to the new template from the Design, and assert it contains `io.github.tonsky/clj-reload {:mvn/version "1.0.0"}`. Windows-quoting assertion: include the escaped form as well.

- [x] **Step 2: Run to verify it fails**
  Run: `npm test -- --grep "replConfig"`
  Expected: FAIL on the template string.

- [x] **Step 3: Implement**
  In `src/repl/replConfig.ts` add `const CLJ_RELOAD_VERSION = "1.0.0";` beside `NREPL_VERSION` and extend the `:extra-deps` map in `defaultCreateCommand`. Update the doc comment: the alias now injects nREPL *and* clj-reload, the latter for reload-before-tests.
  In `package.json`:
  - Add `clojurePulse.test.reloadBeforeRun` after `clojurePulse.inlineEvalResults`: `"type": "string"`, `"enum": ["clj-reload", "none"]`, `"default": "clj-reload"`, `enumDescriptions`, and a `markdownDescription` saying the test commands save dirty Clojure files and reload changed namespaces with clj-reload when it is on the REPL classpath; `none` turns it off. Link to the README section.
  - Replace both template strings (the `replConfigurations` `markdownDescription` example and the default example under it) with the new command, keeping the existing JSON escaping style.

- [x] **Step 4: Run to verify it passes**
  Run: `npm test -- --grep "replConfig"`
  Expected: PASS.

- [x] **Step 5: Commit**
  `git commit -m "Add reloadBeforeRun setting and clj-reload to the REPL command template"`

### Task 3: Reload step in the test cores

**Files:**
- Modify: `src/extension.ts`
- Test: `src/test/replCommands.integration.test.ts`

- [x] **Step 1: Update the existing op-order assertions**
  Every assertion in `replCommands.integration.test.ts` that lists `eval`/`load-file` ops for `runTestAtCursor`, `runNsTests`, `rerunLastTest` (e.g. lines 484, 527 and the ns/rerun equivalents) gets a leading `"eval"`. Where a test inspects "the first eval" or counts evals, adjust accordingly; the reload eval is recognizable by `code.includes("clj-reload.core/reload")`.

- [x] **Step 2: Add the new integration tests**
  Following the existing `connect(server)` + `server.respond` pattern:
  - **failed reload aborts:** respond to an eval whose code contains `clj-reload.core/reload` with `value: '{:failed app.core, :message "Syntax error compiling at (src/app/core.clj:3:1).: boom"}'` plus `status: ["done"]`; run `runTestAtCursor` on a deftest buffer; assert the only `eval`/`load-file` op is the reload eval and `api.testStatusBar.current()` is `undefined` (spinner cleared).
  - **unavailable continues:** respond with `value: ":clojure-pulse/no-reload"`; assert the ops are the reload eval followed by today's sequence.
  - **`none` skips:** set `clojurePulse.test.reloadBeforeRun` to `"none"` (Global target, like `setConfigurations`); assert no eval's code mentions `clj-reload`; reset the setting in `teardown`.
  - **saves before reload:** write a temp `.clj` file (the `fs`/`os`/`path` imports are already there), open it, insert a comment with `editor.edit`, run `runTestAtCursor`; in the responder, when the reload eval arrives, record `doc.isDirty`; assert it was `false`.

- [x] **Step 3: Run to verify the new tests fail**
  Run: `npm test -- --grep "REPL commands"`
  Expected: FAIL — the new tests and the updated op orders.

- [x] **Step 4: Implement in `src/extension.ts`**
  - `reloadSetting(): "clj-reload" | "none"` next to `inlineEnabled()`, reading `clojurePulse.test.reloadBeforeRun` with default `"clj-reload"`.
  - `saveDirtyClojureDocuments(): Promise<void>` — `vscode.workspace.textDocuments` filtered by `languageId === "clojure"`, `isDirty`, `uri.scheme === "file"`; `await doc.save()` for each; ignore `false`.
  - `reloadBeforeTests(session: ReplSessionLike): Promise<ReloadResult | undefined>` — returns `undefined` when the setting is `"none"`; otherwise saves, evals `RELOAD_EXPR` (no `ns` param), returns `parseReloadOutcome(outcome)`. On `unavailable`, shows the status-bar message unless the session is already in the module-level `warnedNoReload: Set<ReplSessionLike>`, then adds it. (Task 4's connect listener removes the session from the set on every `connected`, which is what makes it "once per connection" across in-place restarts.)
  - In `runSingleTest`: after `statusBar.running(found.name)` and inside the `try`, call it. On `failed`: resolve the inline decoration (when `id`) with `{ err: message, namespaceNotFound: false }`, `reportRunError(\`reload failed in ${ns}: ${message}\`)`, `statusBar.clear(barToken)`, return.
  - In `runTestsInDocument`: same, right after `statusBar.running(runName)` inside the `try`, with `reportRunError` and `statusBar.clear`.
  - Update the doc comments of both cores and `rerunLastTest` (the "eval it in the REPL — then re-run" sentence no longer applies).

- [x] **Step 5: Run the suite**
  Run: `npm test`
  Expected: PASS.

- [x] **Step 6: Commit**
  `git commit -m "Save and reload changed namespaces before running tests"`

### Task 4: Prime clj-reload on connect

**Files:**
- Modify: `src/extension.ts`
- Test: `src/test/replCommands.integration.test.ts`

- [x] **Step 1: Write the failing tests, and make the `connect` helper absorb the prime**
  The prime adds an `eval` to every connection, and several existing tests assert that nothing was sent at all (`rerunLastTest before any test command sends nothing`, `evalCurrentForm with no form at the cursor sends nothing`, `runTestAtCursor outside a deftest sends nothing`, `runNsTests with no deftests in the buffer sends nothing`, `rerunLastTest after renaming the deftest sends nothing`, and every `received.find(m => m.op === "eval")`). Rather than touching each, change the `connect(server)` helper: after `startRepl` and the `connected` assertion, when the setting is not `"none"`, `waitUntil` an eval whose code contains `require 'clj-reload.core` has arrived, then `server.received.splice(0)` so tests observe only their own traffic. Then the tests:
  - Connecting sends exactly one eval whose code contains `require 'clj-reload.core`, after the handshake (`clone`/`describe`). Assert inside a test that inspects `server.received` *before* the helper's splice — simplest is a dedicated test that does the configuration + `startRepl` steps inline instead of through `connect`.
  - With the setting `"none"`, no such eval arrives: set the setting, connect through the helper (which then does not wait), run an unrelated `evalSelection`, assert none of the received evals mention `clj-reload`.
  - Restart re-arms the "unavailable" hint: connect, respond `:clojure-pulse/no-reload` to the reload eval, run a test twice (the second run must not warn — observe through a stubbed `setStatusBarMessage` or by exposing the warned set on the test API, whichever the executor finds cleaner), `stopRepl` + `startRepl` the same name, run again and assert the hint shows once more.

- [x] **Step 2: Run to verify they fail**
  Run: `npm test -- --grep "REPL commands"`
  Expected: FAIL — no prime eval.

- [x] **Step 3: Implement**
  In the registry's `createSession` callback (`src/extension.ts` ~line 671), after constructing the `ReplSession`, register a state listener and return the session. On `connected`: `warnedNoReload.delete(session)` (re-arms the one-time hint for this connection), and when `reloadSetting() === "clj-reload"`, `void session.eval(PRIME_EXPR).catch(() => {})`. Comment why: fixes clj-reload's change baseline at connect time; never `init`.

- [x] **Step 4: Run the suite**
  Run: `npm test`
  Expected: PASS.

- [x] **Step 5: Commit**
  `git commit -m "Require clj-reload on connect to fix its change baseline"`

> Deviation: the prime eval needed two supporting changes the plan did not foresee.
> `EvalOptions` gained a `quiet` flag (stripped before the nREPL op is sent) so the prime
> stays out of the transcript — otherwise `(try (require 'clj-reload.core) …)` was the first
> line of every REPL output channel. `src/test/customCommands.integration.test.ts` and
> `src/test/replManager.integration.test.ts` absorb the prime the same way `connect` does,
> and `fakeNreplServer` now skips writes to a destroyed socket (a fire-and-forget prime
> outliving a stopped REPL surfaced as an uncaught EPIPE).
> The warned-set is exposed as `api.warnedNoReload(session)` for the re-arm test.

### Task 5: Docs

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `docs/plans/2026-08-05-0038-rerun-last-test-command.md`

- [x] **Step 1: README**
  Use /writing-clearly.
  - In the Evaluating section's test-command bullets (around lines 482–530): a new lead-in paragraph or bullet **Reload before tests**: each test command saves dirty Clojure files and reloads changed namespaces (and their dependents) with clj-reload when it is on the REPL classpath, so the code you just edited is what runs; a file that fails to compile aborts the run with a notification and the full error in the REPL output; without clj-reload the tests run as before and the status bar says so once. Setting `clojurePulse.test.reloadBeforeRun`. Trim the Run Last Test Command bullet's "eval it in the REPL — then re-run" to match.
  - A short **What the extension assumes** note: it calls plain `clj-reload.core/reload`, never `init` and never a project's own reset wrapper; it does not restart an Integrant/Component/Mount system. Projects that want state to follow reloads use clj-reload's `before-ns-unload` / `after-ns-reload` hooks and `defonce` / `^:clj-reload/keep`, which work unchanged. Link to clj-reload's README.
  - Limits: reload works from disk, so untitled buffers are not covered; the change baseline is the moment `clj-reload.core` is first required, so a self-started `connect` REPL should `(require 'clj-reload.core)` in `user.clj`; JVM only today (let-go runs tests without reloading).
  - REPL `create` section: update the command block and say the alias also injects clj-reload; lein users add `io.github.tonsky/clj-reload "1.0.0"` to their `:dev` profile. Existing saved commands need the dep added by hand.
  - Configuration table: a row for `clojurePulse.test.reloadBeforeRun`.
  - Commands section (lines 635–640): mention the reload in the two test-command entries.

- [x] **Step 2: CHANGELOG**
  Under `[Unreleased]`, a **Reload before tests** entry in the file's style, including the template change and the setting.

- [x] **Step 3: Rerun plan note**
  Under decision 5 in `docs/plans/2026-08-05-0038-rerun-last-test-command.md`, add: `Superseded by docs/plans/2026-09-04-1722-reload-before-tests-clj-reload.md — test commands now reload changed namespaces first.`

- [x] **Step 4: Commit**
  `git commit -m "Document reload-before-tests"`

### Task 6: Manual verification

**Files:** none (scratch project outside the repo)

- [x] **Step 1: JVM**
  Create `/tmp/reload-check` with `deps.edn` (`{:paths ["src" "test"]}`), `src/app/core.clj` (`(defn add [a b] (+ a b))`), `test/app/core_test.clj` (a deftest asserting `(= 3 (add 1 2))`). Open it in the Extension Development Host (`F5`), add a REPL through the form (the prefilled command now includes clj-reload), start it, run the test → pass. Change `add` to return `(* a b)` without saving, run **Run Last Test Command** from `core.clj` → the file is saved and the test fails. Break `core.clj` with an unbalanced form, rerun → notification `reload failed in app.core: …`, no test run, full trace in the REPL output. Fix it, rerun → pass. Confirm `Reloaded 1 namespaces` lines appear in the REPL output.

- [x] **Step 2: Without clj-reload**
  Edit the REPL command to drop the clj-reload dep, restart, run a test → status-bar message about running without reloading, test still runs; a second run shows no message.

- [ ] **Step 3: let-go** — NOT DONE: no `lgx` or `lg` on this machine.
  Against a let-go nREPL (`lgx nrepl` in a let-go project, or `~/Projects/let-go/lg`), run a test: the reload probe must come back as unavailable (keyword or `err`), not break the run. If let-go's `resolve` of a qualified symbol in a missing namespace throws at compile time, fold the probe into `(try … (catch Exception _ :clojure-pulse/no-reload))` in `RELOAD_EXPR` and re-run Task 1's tests.

- [x] **Step 4: Final checks**
  Run: `npm run lint && npm run compile && npm test`
  Expected: all clean.

---

## Completion summary

Every test command now saves the dirty Clojure buffers and reloads the changed
namespaces through clj-reload before it runs anything, and Run Last Test
Command inherits it. Shipped across seven commits, `dfce365` through `061ff57`.
Lint, compile and the full suite (808 tests) are clean.

**Verified against a real JVM nREPL**, not only the fake server. In a scratch
deps.edn project with clj-reload 1.0.0: an unchanged tree returns
`{:loaded 0}`; editing `add` to multiply returns `{:loaded 2}` and the next
call really returns the new value; an unresolvable symbol returns
`{:failed app.core, :message "Syntax error compiling at (app/core.clj:3:17)..."}`;
the fixed file reloads and the test passes. In a project without clj-reload the
probe returns `:clojure-pulse/no-reload` and the prime writes nothing to `err`.

**Deviations** (each also noted under its task):

1. `RELOAD_EXPR` wraps the reload call in `(try ... (catch Exception e ...))`.
   `{:throw false}` only converts *namespace load* failures into the result
   map; clj-reload still throws out of its own scan when a file cannot be read.
   Without the catch that came back as `err` and read as "clj-reload is
   missing", so a broken file would have let the tests run against stale code.
   Found by the codex review of Task 1 and confirmed by the manual run.
2. `EvalOptions` gained a `quiet` flag (stripped before the nREPL op is sent)
   that keeps an eval's code *and* its results out of the transcript. Only the
   connect-time prime uses it; otherwise every fresh REPL channel opened with
   `(try (require 'clj-reload.core) ...)` and a bare `nil`.
3. A reload that fails before it reaches a namespace (`:failed nil`) reports
   the last line clj-reload printed instead of its own exception message, whose
   text is `Cannot throw exception because "exception" is null`. The printed
   line names the file: `Failed to read src/app/core.clj ... EOF while reading,
   starting at line 3`. The notification drops the namespace clause in that
   case. Found only by running it for real.
4. `api.warnedNoReload(session)` is exposed for the re-arm test, per the plan's
   own suggestion.
5. The connect helpers in `customCommands.integration.test.ts` and the `evals`
   helper in `replManager.integration.test.ts` absorb the prime the same way
   `replCommands`' helper does, and `fakeNreplServer` now skips writes to a
   destroyed socket - a fire-and-forget prime outliving a stopped REPL surfaced
   as an uncaught EPIPE.

**Not done:** Task 6 Step 3, the let-go check. Neither `lgx` nor
`~/Projects/let-go/lg` exists on this machine. The risk it covers is whether
let-go's compiler accepts `RELOAD_EXPR` - the `resolve` guard follows the
`run-test-var` probe that already works there, but the `try`/`catch Exception`
that deviation 1 added is new and unverified on let-go. If it does not compile,
the fix is the one the plan already describes: wrap the whole form in
`(try ... (catch Exception _ :clojure-pulse/no-reload))`.

**What the plan could have specified better:** it treated `{:throw false}` as a
guarantee that no exception escapes `reload`, and built the whole
failed/unavailable split on that. It does not hold for a file clj-reload cannot
read, which is the exact case Task 6 Step 1 asks the tester to produce. One
manual probe of the expression against a real clj-reload, written into the plan
as a design step rather than a final task, would have caught both that and the
useless exception message before any code was written.
