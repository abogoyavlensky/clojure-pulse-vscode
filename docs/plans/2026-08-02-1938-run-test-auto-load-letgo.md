# Run Test at Cursor: Auto-Load and let-go Support Implementation Plan

> **For agentic workers:** Use executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Run Test at Cursor load the file's namespace automatically when it isn't loaded, and make the runner expression work on let-go (whose compiler resolves both branches eagerly), dropping pre-1.11 JVM support.

**Tech Stack:** TypeScript VS Code extension, nREPL over bencode, mocha (tdd ui) via `@vscode/test-cli`; validation against real Clojure (CLI) and let-go (`/Users/andrew/Projects/let-go/lg`).

---

## Design

Follow-up to `docs/plans/2026-08-02-1625-run-test-at-cursor.md`, decisions settled in discussion with the user:

### 1. let-go-safe runner expression (replaces the current fallback)

let-go aliases `clojure.test` to its own `test` namespace (`let-go/pkg/rt/lang.go:300`, different design: `let-go/pkg/rt/core/test.lg`), and its compiler resolves symbols in **both** branches of an `if` at compile time. The current fallback references `clojure.test/*initial-report-counters*`, which does not exist on let-go, so the whole form fails to compile there — even though the branch would never run.

New runner, referencing only vars that exist on both runtimes (`*report-counters*` exists on JVM clojure.test and let-go's test ns; let-go's counters map has the same keys as clojure.test's summary):

```clojure
(let [v #'<name>]
  (if-let [f (resolve 'clojure.test/run-test-var)]
    (f v)
    (do (set! clojure.test/*report-counters* {:test 1 :pass 0 :fail 0 :error 0})
        ((deref v))
        clojure.test/*report-counters*)))
```

- JVM 1.11+: primary branch, unchanged (`run-test-var` prints report, returns summary).
- let-go: else branch — let-go's `deftest` defines the test as a plain fn and `is` mutates `*report-counters*` via `set!`, so resetting the counters, calling the fn, and returning the counters map gives `testRunFailed` and the inline display exactly what they expect. `((deref v))` because let-go test vars hold plain functions.
- Pre-1.11 JVM: **unsupported** (decision). The else branch's `set!` throws there; the error shows inline. No `ref`/`binding`/`*initial-report-counters*` anywhere.
- Known accepted limitation: on let-go, single-test runs bypass `*each-fixtures*`/`*once-fixtures*` until let-go gains `run-test-var` upstream (Task 3 files that issue). The primary branch auto-upgrades when it lands.

### 2. Auto-load the namespace on demand

Today a not-yet-loaded test namespace fails the define-eval with `namespace-not-found` and an inline hint telling the user to run Evaluate File. Decision: automate exactly that recovery, once:

1. Define-eval reports `outcome.namespaceNotFound` → call `session.loadFile(document text, {filePath, fileName})` (mirroring `evalFile`'s on-disk handling in `src/extension.ts`).
2. Load outcome has `err` → resolve the inline decoration with the **load** outcome and stop (the file itself doesn't compile; that error wins).
3. Otherwise retry the define-eval once; if it still reports `err`/`namespaceNotFound`, resolve with that outcome and stop. No retry loop.
4. Then run the test as before.

A define-eval that fails with a plain `err` (compile error in the deftest) still stops immediately without loading — auto-load triggers only on `namespaceNotFound`.

### 3. Upstream let-go issue

File `run-test-var.md` in `/Users/andrew/Projects/lgx/docs/issues/` (separate git repo) proposing `test/run-test-var`: reset counters, run one test var through the same fixture composition `run-tests` uses (`test.lg:58-70`), return the counters map. Match the directory's format (`# Issue:` title, **Repo**/**Status** fields, Summary, Concrete impact, sketch; add a row to the README index table with status `draft`). Motivation: editor single-test runs (clojure-pulse's Run Test at Cursor), whose current fallback must bypass fixtures.

### Testing strategy

- Integration (fake nREPL): auto-load sequence (`eval` → `namespace-not-found` → `load-file` → retry `eval` → runner `eval`), load-failure stop, and no-auto-load-on-plain-err (existing test keeps passing). Runner assertions updated to the new snippet.
- Real-runtime validation: run the exact snippet on Clojure CLI (both branches) and on let-go via `/Users/andrew/Projects/let-go/lg` (else branch, pass + fail cases) — this is what the fake server cannot prove.

## File Structure

- **Modify `src/extension.ts`** — new runner string; auto-load-and-retry flow in `runTestAtCursor`.
- **Modify `src/test/replCommands.integration.test.ts`** — new auto-load tests; runner snippet assertions.
- **Create `/Users/andrew/Projects/lgx/docs/issues/run-test-var.md`** — upstream issue (lgx repo).
- **Modify `/Users/andrew/Projects/lgx/docs/issues/README.md`** — index row (lgx repo).
- **Modify `README.md`, `CHANGELOG.md`** — auto-load behavior; let-go support note.

## Tasks

### Task 1: let-go-safe runner expression

**Files:**
- Modify: `src/extension.ts`
- Test: `src/test/replCommands.integration.test.ts`

- [ ] **Step 1: Validate the new snippet on both real runtimes**
  In `$CLAUDE_JOB_DIR/tmp`, write scratch scripts that define a passing and a failing test and evaluate the exact new runner form:
  - Clojure CLI: primary branch (as-is) and else branch (forced, by calling it directly) — expect summary/counters maps, `:fail 1` on the failing test.
  - let-go: run a `.lg` script through `/Users/andrew/Projects/let-go/lg` with `(:require [clojure.test :refer [deftest is]])` — expect the form to compile, PASS/FAIL lines printed, and the returned map to show `:fail 0` / `:fail 1`.
  If let-go rejects any part (e.g. `set!` from another ns), adjust the snippet here before touching the extension, and record the deviation.

- [ ] **Step 2: Update the integration test expectations**
  In the happy-path test, assert the runner eval contains `run-test-var`, `#'my-test`, and `clojure.test/*report-counters*`, and does **not** contain `*initial-report-counters*`.

- [ ] **Step 3: Run tests to verify the new assertions fail**
  Run: `npm run compile-tests && xvfb-run -a npm test`
  Expected: FAIL — the runner still sends the old fallback.

- [ ] **Step 4: Replace the runner string in `runTestAtCursor`**
  Exactly the Design §1 form, on one line as today; update the adjacent comment (drop the pre-1.11 claim, explain the let-go-safe else branch).

- [ ] **Step 5: Run tests to verify they pass**
  Run: `npm run compile-tests && xvfb-run -a npm test`
  Expected: PASS (all suites).

- [ ] **Step 6: Commit**
  `git commit -m "Make the test runner expression let-go-safe"`

### Task 2: Auto-load the namespace and retry

**Files:**
- Modify: `src/extension.ts`
- Test: `src/test/replCommands.integration.test.ts`

- [ ] **Step 1: Write the failing integration tests**
  Using a scriptable fake-server handler (`server.respond`):
  - **Auto-load then run:** first `eval` with `ns` → reply `status ["done" "namespace-not-found"]`; after a `load-file` arrives, `eval`s succeed. Assert op order: `eval` (deftest), `load-file` (content includes the deftest), `eval` (deftest again), `eval` (runner); runner's `ns` still the file's ns.
  - **Load failure stops:** `load-file` replies with `err` → exactly one further op none (no retry eval, no runner).
  - Existing "defining it fails" test (plain `err`) must keep passing unchanged — no `load-file` op appears in it.

- [ ] **Step 2: Run tests to verify they fail**
  Run: `npm run compile-tests && xvfb-run -a npm test`
  Expected: FAIL — today the command stops at `namespace-not-found`.

- [ ] **Step 3: Implement load-and-retry**
  In `runTestAtCursor` per Design §2. Reuse the document/on-disk handling shape from `evalFile`; keep one shared inline decoration across define → load → retry → run.

- [ ] **Step 4: Run tests and lint**
  Run: `npm run pretest && xvfb-run -a npm test`
  Expected: PASS, no lint errors.

- [ ] **Step 5: Commit**
  `git commit -m "Auto-load the namespace when running a test at cursor"`

### Task 3: Upstream let-go issue in lgx

**Files:**
- Create: `/Users/andrew/Projects/lgx/docs/issues/run-test-var.md`
- Modify: `/Users/andrew/Projects/lgx/docs/issues/README.md`

- [ ] **Step 1: Write the issue**
  Follow the directory's format (see `nrepl-port-zero.md`): `# Issue: add test/run-test-var for single-test runs`, **Repo** nooga/let-go, **Status** draft. Summary: `test` ns has only `run-tests` (`pkg/rt/core/test.lg:54`); editors need to run one test var. Concrete impact: clojure-pulse's Run Test at Cursor falls back to `set!` counters + direct fn call, bypassing `*each-fixtures*`/`*once-fixtures*`; `(resolve 'clojure.test/run-test-var)` in its primary branch picks the upstream fn up automatically once it exists. Proposal sketch: reset `*report-counters*`, run the var through the same fixture composition `run-tests` uses (`test.lg:58-70`), return the counters map (keys already match clojure.test's summary).

- [ ] **Step 2: Add the README index row**
  Status `draft`, subject "Add `test/run-test-var` for single-test runs (editor integration)".

- [ ] **Step 3: Commit (lgx repo)**
  `git -C /Users/andrew/Projects/lgx add docs/issues/run-test-var.md docs/issues/README.md && git -C /Users/andrew/Projects/lgx commit -m "Add run-test-var upstream issue"`

### Task 4: Docs and final verification

**Files:**
- Modify: `README.md`, `CHANGELOG.md`

- [ ] **Step 1: Update the docs**
  README (Run Test at Cursor bullets in Evaluating + Commands): the namespace is loaded automatically on first run; works on let-go. CHANGELOG: amend the existing Unreleased "Run Test at Cursor" entry with auto-load and let-go support.

- [ ] **Step 2: Full suite**
  Run: `npm run pretest && xvfb-run -a npm test`
  Expected: PASS.

- [ ] **Step 3: End-to-end on let-go**
  Re-run the Task 1 let-go scratch check against the final committed snippet string (extract it from `src/extension.ts` to ensure no drift), pass + fail cases.

- [ ] **Step 4: Commit**
  `git commit -m "Document auto-load and let-go support for Run Test at Cursor"`
