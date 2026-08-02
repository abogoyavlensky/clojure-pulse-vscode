# Run Test at Cursor Implementation Plan

> **For agentic workers:** Use executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A "Run Test at Cursor" command that finds the top-level `deftest` at (or right after) the cursor, re-evaluates it in the active REPL, runs it via `clojure.test`, and shows the summary inline.

**Tech Stack:** TypeScript VS Code extension, nREPL over bencode, mocha (tdd ui) via `@vscode/test-cli`.

---

## Design

### Approach

A new command `clojurePulse.runTestAtCursor` ("Run Test at Cursor", command palette only, no default keybinding — same as the other eval commands). It resolves the top-level `deftest` form for the cursor with a new pure function in `src/repl/forms.ts`, then performs two evals in the active REPL session:

1. **The `deftest` form itself**, with the file's namespace (via `nsBefore`) and source-location params — redefining the test var so the buffer's *current* version is what runs (Calva/Cursive behavior).
2. **A runner expression** that executes the freshly defined test via `clojure.test`.

### Cursor resolution: `testAtCursor(text, offset)`

New exported function in `src/repl/forms.ts`, reusing the existing `readForm` reader with a top-level walk like `nsBefore`'s:

- Pick the top-level form containing the cursor (`start ≤ offset ≤ end`), or, when the cursor sits in top-level whitespace/trivia, the last top-level form ending before it — this covers "right after the deftest form" and matches `formAtCursor`'s rule 6.
- The resolved form qualifies only if it is a list (opening bracket `(`) whose head token is `deftest`, bare or qualified (`t/deftest`, `clojure.test/deftest` — i.e. the token is `deftest` or ends with `/deftest`). Leading `#_` discard markers are allowed, but any other reader prefix (`'`, `` ` ``, `~`, `^meta`, `#'`) disqualifies it: the check is `form.baseStart === form.innerStart` (the reader already separates discard markers, tracked by `innerStart`, from the other prefixes).
- The test name is the **second child's base token** (`baseStart..end`), which naturally skips `^:integration`-style metadata via the reader's existing prefix handling. The name child must be an atom (`bracketOffset === null`).
- Return shape (locked in so command and tests agree):

  ```ts
  export interface TestAtCursor {
    /** Range of the whole deftest form (leading #_ stripped, like formAtCursor). */
    range: FormRange;
    /** The bare test name, e.g. "my-test" (no namespace, no metadata). */
    name: string;
  }
  export function testAtCursor(text: string, offset: number): TestAtCursor | null;
  ```

- Return `null` when: no top-level form resolves; the resolved form is not a `deftest` list; the name is missing or not an atom; the code is unbalanced. **No fallback** to an earlier deftest when the cursor is inside a different top-level form — the command reports "no deftest found at cursor" instead.
- A `#_`-discarded deftest still resolves (consistent with `formAtCursor`, which strips discard markers so evaluation yields the real form).

### Command flow: `runTestAtCursor` in `src/extension.ts`

1. Guard on `activeSession(registry)` (existing helper — warns with Start/Connect actions when nothing is connected) and `vscode.window.activeTextEditor`.
2. Resolve `testAtCursor`; on `null`, `setStatusBarMessage("Clojure Pulse: no deftest found at cursor", 3000)` and return.
3. Mark **one** inline pending decoration on the deftest form's range (when `inlineEnabled()`); when inline results are off, `session.showOutput()` up front, mirroring `evalCurrentForm`.
4. **Eval 1:** the deftest source with `{ ...sourceParams(editor, range.start), ns: nsBefore(...) }`. If the outcome has `err` or `namespaceNotFound`, resolve the decoration with that outcome (the existing inline handling shows the error / "Namespace not loaded — run 'Evaluate File' first" hint) and stop — do not run the test.
5. **Eval 2:** the runner, in the same ns (no file/line params — it is synthetic code):

   ```clojure
   (let [v #'<name>]
     (if-let [f (resolve 'clojure.test/run-test-var)]
       (f v)
       (binding [clojure.test/*report-counters* (ref clojure.test/*initial-report-counters*)]
         (clojure.test/test-vars [v])
         @clojure.test/*report-counters*)))
   ```

   `run-test-var` (Clojure 1.11+) prints the report and returns the summary map (`{:test 1, :pass 2, :fail 0, :error 0, :type :summary}`). The fallback (older runtimes, let-go's clojure.test subset) runs `test-vars` inside a fresh `*report-counters*` binding and returns the deref'd counters map (`{:test 1, :pass 1, :fail 1, :error 0}`), so **both branches yield a summary map** — the inline result and the failure regex work identically. If an exotic runtime lacks `*report-counters*`, the eval errors and the inline decoration shows the error, which is acceptable.
6. Resolve the pending decoration with eval 2's outcome. Both evals stream through the session transcript, so the full test report lands in the `REPL: <name>` output channel as usual.
7. **Auto-reveal on failure:** if eval 2's `outcome.value` matches `/:fail\s+([1-9]\d*)|:error\s+([1-9]\d*)/` (a pure helper `testRunFailed(value: string | undefined): boolean` in `forms.ts` — testable without vscode), call `session.showOutput()` so the failure report is in view. A thrown eval (transport error) follows the same catch path as `runEval`: fail the decoration, `reportEvalError`.

The two-evals-one-decoration flow means `runEval` is not reused as-is; write a small dedicated async function next to it in `extension.ts`, reusing `sourceParams`, `inlineEnabled`, `activeSession`, and `reportEvalError`.

### Error handling summary

| Situation | Behavior |
|---|---|
| No REPL connected | Existing warning with Start REPL / Connect actions |
| No deftest at cursor | Status-bar message, nothing sent |
| deftest eval fails / ns not loaded | Inline error on the form, runner not sent |
| Test failures/errors | Inline summary map + output channel revealed |
| Transport error mid-run | Decoration fails, error message (same as `runEval`) |

### Testing strategy

- **Unit (pure):** `testAtCursor` cases in `src/test/forms.test.ts` using the existing `|`-marker helper; `testRunFailed` cases alongside.
- **Integration:** in `src/test/replCommands.integration.test.ts` with the fake nREPL server — assert the two eval ops arrive in order with the right code and `ns`, and that no runner is sent when the cursor is not in a deftest.

## File Structure

- **Modify `src/repl/forms.ts`** — add `TestAtCursor`, `testAtCursor`, `testRunFailed`. Pure text functions, no vscode imports (file's existing rule).
- **Modify `src/extension.ts`** — add `runTestAtCursor(registry, inlineResults)` near the other eval commands; register `clojurePulse.runTestAtCursor` in `setupRepl`.
- **Modify `package.json`** — command contribution `{ "command": "clojurePulse.runTestAtCursor", "title": "Run Test at Cursor", "category": "Clojure Pulse" }`.
- **Modify `src/test/forms.test.ts`** — unit suites for `testAtCursor` and `testRunFailed`.
- **Modify `src/test/replCommands.integration.test.ts`** — integration tests for the command.
- **Modify `README.md`, `CHANGELOG.md`** — document the command.

## Tasks

### Task 1: `testAtCursor` + `testRunFailed` in forms.ts

**Files:**
- Modify: `src/repl/forms.ts`
- Test: `src/test/forms.test.ts`

- [ ] **Step 1: Write the failing tests**
  New suite `testAtCursor` in `src/test/forms.test.ts`, reusing the `at()` helper. Cases:
  - cursor inside a deftest body → `{name: "my-test"}` and range = whole form text
  - cursor on the test name; cursor immediately after the closing paren
  - cursor in whitespace after the deftest (next line) → still that deftest
  - qualified heads: `(t/deftest foo ...)`, `(clojure.test/deftest foo ...)`
  - metadata on the name: `(deftest ^:integration foo ...)` → name `foo`
  - cursor inside a non-deftest top-level form (e.g. the `ns` form, or a `defn` between two deftests) → null
  - cursor in whitespace after a non-deftest form → null
  - unbalanced deftest → null; empty buffer → null; `(deftest)` with no name → null
  - `#_(deftest foo ...)` with cursor inside → resolves with range starting at `(`
  - `'(deftest foo ...)` (or any non-discard prefix) with cursor inside → null
  New suite `testRunFailed`: `"{:test 1, :pass 2, :fail 0, :error 0, :type :summary}"` → false; `:fail 1` → true; `:error 2` → true; `undefined` → false; `"nil"` → false; `:fail 10` → true; fallback-shaped map without `:type` (`"{:test 1, :pass 0, :fail 1, :error 0}"`) → true.

- [ ] **Step 2: Run tests to verify they fail**
  Run: `npm run compile-tests && npm test`
  Expected: FAIL — new tests error (functions not exported yet).

- [ ] **Step 3: Implement `testAtCursor` and `testRunFailed`**
  In `src/repl/forms.ts`, per the Design section: top-level walk with `readForm` (pattern of `nsBefore`), containing-or-previous form selection, deftest head check, second-child name extraction, and the failure regex. Keep the file free of vscode imports.

- [ ] **Step 4: Run tests to verify they pass**
  Run: `npm run compile-tests && npm test`
  Expected: PASS (all suites, including existing ones).

- [ ] **Step 5: Commit**
  `git commit -m "Add deftest resolution at cursor to forms"`

### Task 2: Command wiring and eval flow

**Files:**
- Modify: `src/extension.ts`, `package.json`
- Test: `src/test/replCommands.integration.test.ts`

- [ ] **Step 1: Write the failing integration tests**
  In the existing "REPL commands" suite (fake nREPL server + temp docs pattern used by the `evalCurrentForm` tests):
  - `runTestAtCursor` with cursor inside a deftest sends two evals in order: (1) the deftest source with `ns` set from the file's `ns` form, (2) code containing `run-test-var` and `#'my-test`, same `ns`.
  - cursor not in a deftest → no eval ops sent, command resolves.
  - no connection → warns instead of throwing (mirror the existing disconnected test).
  - deftest eval returning `err` → runner eval is not sent (fake server can respond with an error for the first eval).

- [ ] **Step 2: Run tests to verify they fail**
  Run: `npm run compile-tests && npm test`
  Expected: FAIL — `clojurePulse.runTestAtCursor` not found.

- [ ] **Step 3: Implement the command**
  - `package.json`: add the command contribution (title "Run Test at Cursor", category "Clojure Pulse").
  - `src/extension.ts`: implement `runTestAtCursor` per the Design flow (guard, resolve, one pending decoration, eval deftest, stop on `err`/`namespaceNotFound`, eval runner, resolve decoration, `showOutput()` when `testRunFailed(outcome.value)`); register it in `setupRepl`.

- [ ] **Step 4: Run tests and lint**
  Run: `npm run pretest && npm test`
  Expected: PASS, no lint errors.

- [ ] **Step 5: Commit**
  `git commit -m "Add Run Test at Cursor command"`

### Task 3: Docs

**Files:**
- Modify: `README.md`, `CHANGELOG.md`

- [ ] **Step 1: Document the command**
  README: add "Run Test at Cursor" to the REPL commands section (works inside or right after a `deftest`; re-evaluates the test, inline summary, output channel opens on failure). CHANGELOG: entry under Unreleased.

- [ ] **Step 2: Commit**
  `git commit -m "Document Run Test at Cursor"`
