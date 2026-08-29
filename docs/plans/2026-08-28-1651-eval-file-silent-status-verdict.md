# Silent Evaluate File Implementation Plan

> **For agentic workers:** Use executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop **Evaluate File** from opening and focusing the REPL output panel; report the load through the shared status-bar slot instead, and stop every other eval/test command from stealing editor focus when it does reveal the channel.

**Tech Stack:** TypeScript, VS Code extension API (`OutputChannel.show(preserveFocus)`, `StatusBarItem`), existing REPL stack (`ReplSession`, `StatusSlot`, `CommandStatusBar`, `InlineResultsManager`), mocha via `vscode-test`.

---

## Design

### The problem

`ReplSession.showOutput()` calls `channel.show()` with no argument, which VS Code reads as *reveal **and** focus*. Five call sites use it as run feedback:

| Site | Today |
| --- | --- |
| `evalFile` (`src/extension.ts:1727`) | reveals + focuses on **every** run |
| `evalSelection` (`:1252`) | reveals + focuses on every run, even with inline results on |
| `evalCurrentForm` (`:1301`) | reveals + focuses when inline results are off |
| `runSingleTest` (`:1390`) | reveals + focuses when inline results are off |
| `runTestsInDocument` (`:1595`) | reveals + focuses when inline results are off |

So evaluating code yanks the cursor out of the editor into `REPL: <name>`. The README already claims test reports stream "without moving focus there" (line 320) — today that is not true.

For `evalFile` the reveal is doing double duty: it is also the *only* place a compile error shows up. `loadFile` returns a failure as `outcome.err`, which `evalFile` ignores — it reports only a *thrown* error (connection dropped mid-run). Removing the reveal without adding feedback would make a broken file load silently.

### The shape of the fix

Two independent changes.

**1. Evaluate File becomes a silent command with a status-bar verdict.** It stops calling `showOutput()` entirely and instead drives the shared status slot, exactly like custom REPL commands do: `$(loading~spin) core.clj` while the load is in flight, then `$(check) core.clj` in green or `$(error) core.clj — failed` on a red background, clickable to open the REPL output. The slot is shared with test runs and custom commands — whichever ran last owns the display, which is the established design in `src/repl/statusSlot.ts`.

It reuses the existing `CommandStatusBar` presenter rather than adding a third sibling of `testStatusBar.ts` / `commandStatusBar.ts`. The presentation is already generic over a run `name`; a file's basename fits it with no new module.

The run's display name is `basename(doc.uri.path) || "file"` — one rule for every scheme, no branching. A file on disk reads `core.clj`, an untitled buffer reads `Untitled-1` (VS Code puts that in the URI path), and a `jar:` buffer from the External Libraries panel reads its entry's file name. `uri.path` rather than `uri.fsPath` because the latter is meaningless for non-file schemes.

**2. Every remaining reveal preserves focus.** `ReplChannel.show` and `ReplSessionLike.showOutput` gain an optional `preserveFocus` flag (default `false`, matching `vscode.OutputChannel.show`'s own signature — the real channel needs no adapter). The four run-feedback sites pass `true`. The two places where the panel *is* the destination keep the focusing default: the **Show REPL Output** command (`:961`) and the "Show Output" button on a start-failure notification (`:856`).

`evalSelection` additionally becomes conditional like `evalCurrentForm`: with inline results on, the result already appears inline and the channel must not open at all; with inline results off, the channel is the only place a value appears, so it still opens — just without focus.

### Error surfacing

No notification popup for a failed load. A compile error is a red-background status item with the failure's first line in its tooltip, plus click-to-output — the same deal custom REPL commands already offer. Popping a toast on every failed re-load while fixing a syntax error would be noise.

To make that tooltip carry real information, `CommandStatusBarRun`'s `done` variant gains an optional `error` field, and the failure presentation folds its first line (truncated by the existing `truncate` helper) into the tooltip. Custom REPL commands pass `outcome.err` through the same field and get the same benefit.

A **thrown** eval keeps its error notification. That is a dropped connection or a timeout, not a problem with the user's code, and it is what `runEval` already does for the other eval commands.

### Testing strategy

Unit tests at the two seams, following the repo's existing fakes:

- `src/test/replSession.test.ts` — the fake channel records the `preserveFocus` argument; assert `showOutput(true)` forwards it and `showOutput()` does not.
- `src/test/commandStatusBar.test.ts` — assert the failure presentation puts the error's first line in the tooltip, truncates a long or multi-line one, and still reads sensibly with no error text.
- `src/test/replCommands.integration.test.ts` — the existing `evalFile` test only proves a `load-file` op was sent; it would still pass if the command opened the panel or reported a failed load as success. Two new tests drive the fake nREPL through both outcomes and assert the resulting status-slot view: a successful load shows a `$(check)` with the document's name and no error background, and a load whose response carries `err` shows the error background with the failure's first line in the tooltip. The extension's `activate()` already returns `commandStatusBar`, so the suite's `ExtensionApi` interface just needs the field; `FakeNrepl.respond()` supplies the failing `load-file` reply.

Focus itself is deliberately **not** asserted in the integration tests: `activeTextEditor` behaviour when the output panel opens is host-dependent and would be flaky.

---

## File Structure

**Modify:**

- `src/repl/replSession.ts` — widen `ReplChannel.show` and `ReplSessionLike.showOutput` / `ReplSession.showOutput` with an optional `preserveFocus` flag.
- `src/repl/commandStatusBar.ts` — add `error?: string` to the `done` run variant; fold its first line into the failure tooltip.
- `src/extension.ts` — rewrite `evalFile` to drive the status bar and never reveal; make `evalSelection` conditional; pass `preserveFocus: true` at the four run-feedback reveal sites; pass `outcome.err` from `runCustomReplCommand`.
- `src/test/replSession.test.ts` — fake channel records the flag; new assertions.
- `src/test/commandStatusBar.test.ts` — new failure-tooltip assertions.
- `src/test/replRegistry.test.ts` — fake session's `showOutput` signature.
- `README.md` — Evaluate File / Evaluate Selection descriptions; the test-run paragraph at line ~320; the status-bar sharing note.
- `CHANGELOG.md` — an Unreleased entry.

**No new files.** Every piece this needs already exists.

---

### Task 1: Reveal without stealing focus

**Files:**
- Modify: `src/repl/replSession.ts`
- Test: `src/test/replSession.test.ts`, `src/test/replRegistry.test.ts`

- [x] **Step 1: Write the failing test**
  In `src/test/replSession.test.ts`, extend `fakeChannel` (line 11) to record each `show` call's argument — e.g. alongside `shown()`, expose `preserveFocusCalls: () => Array<boolean | undefined>`. Extend the existing `showOutput reveals the channel` test, or add a sibling, asserting that `session.showOutput(true)` forwards `true` to the channel and a bare `session.showOutput()` forwards `undefined`/`false`.

- [x] **Step 2: Run the test to verify it fails**
  Run: `make test`
  Expected: FAIL — `showOutput` takes no argument, so the recorded value is never `true` (and TypeScript rejects the call).

- [x] **Step 3: Widen the signatures**
  In `src/repl/replSession.ts`: `ReplChannel.show(preserveFocus?: boolean): void`, `ReplSessionLike.showOutput(preserveFocus?: boolean): void`, and `ReplSession.showOutput(preserveFocus = false)` forwarding to `this.ensureChannel().show(preserveFocus)`. Update the doc comment to say it reveals the channel and, with `preserveFocus`, leaves the cursor where it is. `vscode.OutputChannel` already matches this shape, so `createChannel` in `src/extension.ts:516` needs no change.
  Update the fake session in `src/test/replRegistry.test.ts:57` to accept the optional argument.

- [x] **Step 4: Run the test to verify it passes**
  Run: `make test`
  Expected: PASS

- [x] **Step 5: Commit**
  `git commit -m "feat: let showOutput reveal the REPL channel without taking focus"`

---

> Deviation: this checkout had no `node_modules` and the VS Code test host could not launch
> (18 missing system libraries, no X server). `npm install` + `mise install` fixed the
> toolchain; the OS packages (`xvfb`, `libnss3`, `libgtk-3-0t64`, …) were installed by the
> user on request. No plan step changed.

### Task 2: Failure tooltips carry the error

**Files:**
- Modify: `src/repl/commandStatusBar.ts`
- Test: `src/test/commandStatusBar.test.ts`

- [x] **Step 1: Write the failing test**
  In `src/test/commandStatusBar.test.ts`, next to `failure uses the error background` (line 64), assert that `commandStatusBarPresentation({ phase: "done", name: "core.clj", status: "err", error: "Syntax error ...\nat line 12" })` puts the error's **first line** in the tooltip, that a >100-char error is truncated with an ellipsis (reuse the existing `truncate` behaviour asserted at lines 31 and 42), and that omitting `error` still produces the current sensible failure tooltip.

- [x] **Step 2: Run the test to verify it fails**
  Run: `make test`
  Expected: FAIL — `error` is not part of `CommandStatusBarRun`, and the failure tooltip is a fixed string.

- [x] **Step 3: Implement**
  Add `error?: string` to the `done` variant of `CommandStatusBarRun`. In the failure branch of `commandStatusBarPresentation`, pass `run.error` through the existing `truncate` and include it in the tooltip when present, keeping the "click to show REPL output" tail. `text` stays `$(error) ${name} — failed`; do not put the error in the status bar item's label.

- [x] **Step 4: Run the test to verify it passes**
  Run: `make test`
  Expected: PASS

- [x] **Step 5: Commit**
  `git commit -m "feat: show the failure reason in the command status bar tooltip"`

---

### Task 3: Evaluate File runs silently with a status verdict

**Files:**
- Modify: `src/extension.ts`
- Test: `src/test/replCommands.integration.test.ts`

- [x] **Step 1: Write the failing tests**
  In `src/test/replCommands.integration.test.ts`, add `commandStatusBar: CommandStatusBar` to the suite's `ExtensionApi` interface (line 14) — `activate()` already returns it — and add two tests next to `evalFile sends the buffer through the load-file op` (line 217):
  - **success:** connect to the fake nREPL, open a Clojure document, run `clojurePulse.evalFile`, then assert `api.commandStatusBar.current()` shows the document's name with a `$(check)` and no `backgroundColor`.
  - **failure:** override the fake with `server.respond(...)` so `load-file` replies with an `err` chunk (plus a `done` status), run the command, and assert the view uses `statusBarItem.errorBackground` and carries the error's first line in its tooltip.

  Note in a comment that the slot is shared with test runs and custom commands, so these assertions read the *last* run of any kind — which, within a test, is this command's.

- [x] **Step 2: Run the tests to verify they fail**
  Run: `make test`
  Expected: FAIL — `evalFile` never touches the status bar, so `current()` is `undefined` (and TypeScript rejects `api.commandStatusBar` until the interface gains the field).

- [x] **Step 3: Rewrite `evalFile`**
  `evalFile` (line 1727) takes the `CommandStatusBar` as a second parameter and no longer calls `session.showOutput()` at all. The run's display name is `basename(doc.uri.path) || "file"` — one rule for every scheme. It opens the spinner with `bar.running(name)` **after** `activeSession()` and the active-editor guard — so a run that never happens cannot flash a spinner, matching the ordering comment in `runCustomReplCommand` (line 1165) — and finishes with:

  ```ts
  bar.finish(token, {
    phase: "done",
    name,
    status: outcome.err === undefined ? "ok" : "err",
    value: outcome.value,
    error: outcome.err,
  });
  ```

  A thrown `loadFile` finishes the token as `status: "err"` with the thrown reason as `error`, and still calls `reportEvalError(err)` — a dropped connection stays loud.

- [x] **Step 4: Wire the registration**
  Update the `clojurePulse.evalFile` registration (line 667) to pass `commandBar`.

- [x] **Step 5: Pass the error through for custom commands**
  In `runCustomReplCommand` (line 1173), include `error: outcome.err` in the successful-await `bar.finish` call so a failed custom command gets the same tooltip detail.

- [x] **Step 6: Run the tests to verify they pass**
  Run: `make check`
  Expected: PASS — lint, compile, and the whole suite, including the pre-existing `evalFile sends the buffer through the load-file op`.

- [x] **Step 7: Commit**
  `git commit -m "feat: report Evaluate File in the status bar instead of opening the output panel"`

> Deviation: the success test opens a real temp `.clj` file rather than an untitled buffer, so
> it can assert the exact verdict text (`$(check) verdict.clj`) instead of a host-assigned
> `Untitled-N` name; the failure test keeps an untitled buffer, which also exercises the
> non-file-scheme name fallback.


---

### Task 4: The remaining reveals stop stealing focus

**Files:**
- Modify: `src/extension.ts`

- [x] **Step 1: Make `evalSelection` conditional**
  Replace the unconditional `session.showOutput()` at line 1266 with the `evalCurrentForm` pattern: reveal only when `!inlineEnabled()`, and pass `preserveFocus: true`. With inline results on, `runEval` already paints the value on the selection — the channel must not open.

- [x] **Step 2: Preserve focus at the other three sites**
  Pass `true` to `showOutput` in `evalCurrentForm` (line 1313), `runSingleTest` (line 1401), and `runTestsInDocument` (line 1606). Leave `showReplOutput` (line 970) and the start-failure notification action (line 856) focusing, and update the comment above `evalCurrentForm`'s reveal so it says the channel opens without taking focus.

- [x] **Step 3: Verify**
  Run: `make check`
  Expected: PASS

- [x] **Step 4: Manual smoke check**
  In the Extension Development Host: with inline results on, **Evaluate File** leaves the cursor in the editor and the panel closed, and the status bar shows the file name (green on success; red with the reason in its tooltip for a file with a syntax error). **Evaluate Selection** shows its result inline with the panel still closed. With `clojurePulse.inlineEvalResults` off, selection/form/test commands open the channel but the cursor stays in the editor.

- [x] **Step 5: Commit**
  `git commit -m "feat: keep editor focus when eval and test commands reveal REPL output"`

---

### Task 5: Documentation

**Files:**
- Modify: `README.md`, `CHANGELOG.md`

- [x] **Step 1: Update the README**
  - **Evaluate File** (line 310): it runs silently — no output panel — with the verdict in the status bar, clickable to open the REPL output.
  - **Evaluate Selection** (line 313): the result appears inline; the channel opens only when inline results are off.
  - The test-run paragraph (line ~320): "without moving focus there" is now true; note that the channel, when it opens, does not take focus.
  - The status-bar sharing note (line ~407) and the command list (lines 455-456): the verdict spot now carries test runs, custom commands, **and** file loads — the last run of any kind wins.

- [x] **Step 2: Update the CHANGELOG**
  Add an `## [Unreleased]` section above `## [0.2.0]` describing the behaviour change: Evaluate File no longer opens the output panel and reports through the status bar, and eval/test commands no longer move focus out of the editor.

- [x] **Step 3: Verify**
  Run: `make check`
  Expected: PASS

- [x] **Step 4: Commit**
  `git commit -m "docs: describe silent Evaluate File and focus-preserving output reveals"`

---

## Completion Summary

**Status: complete.** All five tasks implemented, `make check` green — lint, compile, and 648
passing tests (up from 643 at the start).

**What shipped**

- **Evaluate File is silent.** It never reveals the REPL output channel. The shared status slot
  carries the run: `$(loading~spin) core.clj`, then `$(check) core.clj` in green or
  `$(error) core.clj — failed` on a red background whose tooltip holds the compile error's first
  line. Clicking it opens the REPL output, which still has the full report. A *thrown* load (the
  connection dropped) additionally keeps its notification.
- **Nothing steals editor focus.** `ReplChannel.show` / `showOutput` take an optional
  `preserveFocus`; the four run-feedback reveals pass `true`, while the explicit **Show REPL
  Output** command and the start-failure notification action still focus deliberately.
  Evaluate Selection now reveals only when inline results are off, matching Evaluate Current Form.
- **Failure tooltips explain themselves.** `CommandStatusBarRun` gained an `error` field, so a
  failed custom REPL command names its reason too.

**Deviations**

> Environment: this checkout had no `node_modules`, and the VS Code test host could not launch
> (18 missing system libraries, no X server). `npm install` + `mise install` fixed the toolchain;
> the OS packages were installed by the user on request. No plan step changed.

> Task 3's success test opens a real temp `.clj` file rather than an untitled buffer, so it can
> assert the exact verdict text (`$(check) verdict.clj`) instead of a host-assigned `Untitled-N`
> name. The failure test keeps an untitled buffer, which also exercises the non-file-scheme
> name fallback.

> Two fixups came out of the codex review checkpoints, both in `truncate`: pick the first
> *nonblank* line (an nREPL `err` chunk routinely opens with a newline, which would have made the
> tooltip a bare "…"), and fall back to the generic wording when the reason is only whitespace.

> Task 4's manual smoke check in the Extension Development Host was replaced by an automated
> integration test — it spies on the live session's `showOutput` in the real VS Code host and
> asserts Evaluate File never reveals, Evaluate Current Form does not reveal with inline results
> on, and reveals with `preserveFocus: true` when they are off. Stronger evidence than a manual
> pass, and it stays as coverage.

**What the plan could have specified better**

Two things. First, it should have opened with an environment check — "confirm `make check` runs
green before touching code" — because the suite could not run at all here and that surfaced only
at Task 1's verify step. Second, it dismissed asserting "`showOutput` is not called" as
impractical in the real host; monkey-patching the session the registry hands the commands turned
out to be easy, and that assertion is the one that actually pins the feature's central promise.
The plan should have specified it instead of leaving the behavior to a manual check.
