# Eval Current Form / File + Inline Results Implementation Plan

> **For agentic workers:** Use executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Evaluate the innermost form at the cursor or the whole file over the existing nREPL connection, and show evaluation results inline in the editor next to the evaluated code.

**Tech Stack:** TypeScript, VS Code extension API (TextEditorDecorationType with `after` ghost text, hover MarkdownString), existing nREPL client (`src/nrepl/`), mocha via `@vscode/test-cli`.

---

## Design

### Overview

Builds on the nREPL feature shipped in `2026-07-06-nrepl-connect-repl-pane.md`, which deliberately deferred namespace handling and inline decorations. Three additions:

1. **Evaluate Current Form** — innermost-form semantics with an Emacs `eval-last-sexp`-style "form right before the cursor" rule, namespace-aware.
2. **Evaluate File** — whole buffer via the nREPL `load-file` op, so the file's own `ns` form takes effect and stack traces carry real file/line info.
3. **Inline results** — the evaluated form flashes, then a ghost-text decoration (` => value`) appears at the end of its line: dimmed while pending, subtle green on success, red first-line-of-error on failure. Hover shows the full value with a Copy link. The REPL pane keeps receiving the full history exactly as today.

Form boundaries are computed client-side by pure TypeScript reusing the `Scanner` machinery in `src/indent.ts` — the REPL feature stays fully independent of the clj-pulse language server (an explicit design principle of the previous plan). Display uses only stable VS Code API (decorations + hover), the pattern proven by Calva and Quokka.js; editor insets and NES-style overlays remain proposed-only APIs and are not usable in marketplace extensions.

### Command semantics

**`clojurePulse.evalCurrentForm` — "Evaluate Current Form".** Target resolution, in priority order:

1. Non-empty selection → evaluate the selected text verbatim.
2. Cursor inside an atom token (symbol, keyword, number, string literal) or immediately after its last character → evaluate that token.
3. Character immediately before the cursor is a closing bracket (`)`, `]`, `}`) or the closing `"` of a string → evaluate that whole balanced form.
4. Cursor immediately before the first character of a token → evaluate that token. (Ordered after rule 3 so in the sandwich case `(foo)|bar` the *preceding* form wins.)
5. Cursor in whitespace inside a list → evaluate the innermost enclosing form.
6. Cursor in whitespace at top level → walk back over whitespace to the previous top-level form and apply rules 2–3. Nothing before the cursor → "no form found".

Refinements:

- Reader prefixes contiguous with the resolved form are included: `'form`, `` `form ``, `~form`, `~@form`, `@form`, `#'sym`, `#(...)`, `#{...}`, `#"..."`, `^meta form` (metadata plus the form it annotates).
- A `#_` discard prefix is **stripped**: evaluating a discarded form returns its actual value.
- `(comment ...)` bodies need no special case — innermost semantics evaluate the inner form the cursor is in.
- Namespace: the nearest top-level `(ns name ...)` form above the evaluated form supplies the `ns` param; none found → no param (nREPL defaults to `user`). `file`, `line`, `column` params are sent for stack-trace locations (1-based line and column; `file` only for on-disk documents).

**`clojurePulse.evalFile` — "Evaluate File".** Sends the entire buffer text (including unsaved changes) via the nREPL **`load-file` op** with `file-path` (absolute) and `file-name` (basename); untitled documents send only the content. No client-side ns handling — `load-file` compiles the buffer as a unit. Results go to the REPL pane (no cursor form to anchor an inline result to), and the pane is revealed.

**`clojurePulse.evalSelection`** keeps its current behavior (evaluates the selection, reveals the pane) and additionally shows the inline result on the selection when inline results are enabled.

**Supporting commands:** `clojurePulse.clearInlineResults` ("Clear Inline Results") and `clojurePulse.copyEvalResult` ("Copy Evaluation Result" — copies the full value of the result at the cursor, falling back to the most recent one; also invoked by the hover's Copy link with the result id as argument).

No default keybindings — all commands are palette-only; users bind their own.

### Inline results UX

- **Rendering:** one `TextEditorDecorationType` per state (pending / success / error), applied per-range with `renderOptions.after.contentText`. Content is ` => ` + the first line of the value, capped at 120 characters, spaces replaced with non-breaking spaces (regular spaces collapse in decoration rendering). Colors via `ThemeColor`: pending `descriptionForeground`, success `terminal.ansiGreen`, error `errorForeground`.
- **Pending:** the ghost text ` => …` appears immediately when the eval is sent, so slow evals have visible feedback.
- **Highlight flash:** the resolved form's exact range gets a short-lived background decoration (`editor.wordHighlightBackground`, removed after ~200 ms) — feedback showing precisely what was sent.
- **Hover:** the evaluated range's `DecorationOptions.hoverMessage` is a trusted `MarkdownString`: the full value in a ```clojure code fence plus a `[Copy result](command:clojurePulse.copyEvalResult?...)` link. This is how the non-selectable ghost text is made copyable.
- **stdout/stderr never render inline** — they stream to the REPL pane as today. Errors render their first line inline; the full trace is in the pane and hover.
- **Lifecycle:** one result per line — a new eval whose result lands on the same end line replaces the previous result there. A document edit that intersects a result's range clears that result; edits entirely above/below shift the surviving results' ranges by the line delta so they stay glued to their form. Results otherwise persist until "Clear Inline Results" or the document is closed. They are **not** cleared on disconnect — a mid-eval socket drop then resolves its pending decoration to the failure instead of silently vanishing, and past results stay readable (Calva does the same).
- **Setting:** `clojurePulse.inlineEvalResults` (boolean, default `true`). Off → no decorations at all; pane behavior unchanged.
- **Focus behavior:** `evalCurrentForm` does **not** reveal the REPL pane when inline results are on (the result is visible in place); it reveals the pane when they are off. `evalFile` and `evalSelection` always reveal the pane.

### Scope cuts (deliberate)

Single primary cursor only (no parallel multi-cursor evals), no interrupt command, no watches, sequential evals on the one shared session, no pretty-printing middleware. All future work.

### Architecture

```
Eval command (extension.ts)
  → forms.ts: formAtCursor(text, offset) / nsBefore(text, start)   [pure, sync]
  → inlineResults: markPending(editor, range) + flash              [if setting on]
  → ConnectionManager.eval(code, {ns, file, line, column})
      → NreplClient eval op → streams value/out/err to transcript (unchanged)
      → resolves with EvalOutcome { value?, err?, namespaceNotFound? }
  → inlineResults.resolve(id, outcome)
```

New/changed units:

- **`src/repl/forms.ts` (new, pure):** `formAtCursor(text: string, offset: number): { start: number; end: number } | null` implementing the six rules plus refinements, and `nsBefore(text: string, offset: number): string | undefined`. Implemented as a single forward scan (extending or wrapping `Scanner` from `src/indent.ts`, which already handles strings, comments, regex, char literals, and dispatch): while scanning to the cursor, track the open-frame stack, the last completed form at each open level, and current-token boundaries; after the cursor, scan forward only as far as needed to close the relevant form. Forward-only scanning avoids unreliable backward parsing over strings. Malformed/unbalanced code returns `null` (or the best complete form) — never garbage ranges. No vscode imports.
- **`src/repl/inlineResults.ts` (new):** `InlineResultsManager` owning the decoration types and per-document result state (`Map<uriString, InlineResult[]>` where `InlineResult = { id, range, state, text, fullText }`). API: `markPending(editor, range): id`, `resolve(id, outcome)` (a silent no-op when the id was already dropped by an edit, an explicit clear, or the document closing), `fail(id, message)`, `clearAll()`, `resultAt(uri, line)` / `latest()` for the copy command, `dispose()`. Subscribes to `onDidChangeTextDocument` (intersect → drop; above/below → shift) and `onDidCloseTextDocument` (drop state). Pure presentation helpers exported for unit tests: inline text formatting (first line/cap/NBSP), hover markdown building, and range shifting.
- **`src/nrepl/client.ts` (modify):** `eval(code, session, onMessage?, extra?)` where `extra` may carry `ns`, `file`, `line`, `column` (spread into the request); new `loadFile(file, session, onMessage?, extra?)` sending `op: "load-file"` with optional `file-path`/`file-name`. Both remain thin wrappers over `send`.
- **`src/repl/connectionManager.ts` (modify):** `eval(code, opts?)` passes params through and now resolves with `EvalOutcome = { value?: string; err?: string; namespaceNotFound: boolean }` — last `value`, concatenated `err` chunks, `namespace-not-found` detected from response `status`. Transcript streaming is unchanged (existing callers unaffected). New `loadFile(content, { filePath?, fileName? })` with the same outcome shape; appends an `info` transcript entry (`Loading <name>…`) instead of an `in` entry with the whole file text.
- **`src/extension.ts` (modify):** registers the new commands, wires guards (not connected → existing warning with Connect button; no active editor / no form → 3-second status-bar message, nothing sent), reads the setting, exposes the inline manager on `ExtensionApi` for integration tests.
- **`package.json` (modify):** 4 new commands, 1 new setting.

### Error handling

- Not connected → existing warning notification with a "Connect" action (same as `evalSelection` today).
- No form found at cursor → transient status-bar message ("No form found at cursor"), no request sent, no decoration.
- Evaluation error → inline red ghost text with the error's first line; full error in pane and hover; outcome's `err` is preferred over `value` for display.
- `namespace-not-found` status → inline error "Namespace not loaded — run 'Evaluate File' first".
- Socket drop / eval rejection mid-flight → pending decoration resolves to an error state with the failure reason; no unhandled rejection.
- Untitled documents → form eval omits `file`; `load-file` sends content without path params.
- Setting off → commands still work, results go to the pane only.

### Testing strategy

- **`forms.ts`** gets the heaviest coverage (pure unit tests): every rule and refinement — nested forms, token touching (before/inside/after), closer-before-cursor for all bracket kinds and strings, whitespace-in-list → enclosing form, top-level walk-back, reader prefixes, `#_` stripping, `(comment ...)` inner form, brackets inside strings/regex/char literals/comments, `ns` detection (nearest preceding, with metadata/docstring in the ns form), malformed code → `null`, empty text, cursor at offsets 0 and end.
- **`inlineResults`** presentation helpers: pure unit tests for truncation/NBSP escaping, hover markdown, and range shifting on edits (intersecting, above, below, multi-line delta).
- **`NreplClient` / `ConnectionManager`:** fake-nREPL-server tests asserting `ns`/`file`/`line`/`column` land on the wire, `load-file` op shape, `EvalOutcome` for value / error / namespace-not-found responses.
- **Command wiring:** integration tests in the VS Code test host with the fake server — commands registered, `evalCurrentForm` on a cursor inside a form produces the right `in`/`value` transcript entries and an inline result on the manager, no-form case resolves without throwing, `evalFile` sends `load-file`.

## File Structure

```
src/
  repl/
    forms.ts              # NEW: pure form-boundary + ns detection (single forward scan)
    inlineResults.ts      # NEW: InlineResultsManager + pure presentation helpers
    connectionManager.ts  # MODIFY: eval opts + EvalOutcome, loadFile
    replPanel.ts          # (unchanged)
  nrepl/
    client.ts             # MODIFY: eval extra params, loadFile op
  test/
    forms.test.ts                     # NEW
    inlineResults.test.ts             # NEW
    nreplClient.test.ts               # MODIFY: params/load-file cases
    connectionManager.test.ts         # MODIFY: outcome/loadFile cases
    replCommands.integration.test.ts  # MODIFY: new command coverage
  extension.ts            # MODIFY: command wiring, ExtensionApi.inlineResults
package.json              # MODIFY: commands + setting
README.md, CHANGELOG.md   # MODIFY: docs
```

---

### Task 1: form boundaries and ns detection (`forms.ts`)

**Files:**
- Create: `src/repl/forms.ts`
- Test: `src/test/forms.test.ts`

- [x] **Step 1: Write failing tests**
  Cover `formAtCursor` rules in order: (2) cursor inside a symbol, keyword, number, or string, and immediately after its last character; (3) cursor right after `)`/`]`/`}`/closing `"` returns the whole balanced form; (4) cursor immediately before a token's first character returns that token, but `(foo)|bar` returns `(foo)` (rule 3 wins the sandwich); (5) cursor in whitespace inside `(foo | bar)` returns the enclosing list; (6) cursor in top-level whitespace after a form walks back to it; nothing before → `null`. Refinements: `'`, `` ` ``, `~`, `~@`, `@`, `#'`, `#(...)`, `#{...}`, `#"..."`, `^:kw form` prefixes included; `#_form` returns the form without `#_`; cursor inside a form within `(comment ...)` returns the inner form. Robustness: brackets inside strings/regex/char literals/line comments are ignored; unbalanced text → `null`; empty text; offsets 0 and `text.length`. Cover `nsBefore`: plain `(ns foo.bar)`, ns with metadata/docstring, nearest of several ns forms, no ns → `undefined`, `ns` mentioned in nested position is not picked up.

- [x] **Step 2: Run tests to verify they fail**
  Run: `make test`
  Expected: FAIL — `forms.ts` does not exist.

- [x] **Step 3: Implement `forms.ts`**
  Single forward scan reusing/extending `Scanner` from `src/indent.ts`. While scanning up to the cursor offset, maintain: the open-frame stack (Scanner already does), the last completed form's `[start, end]` at each currently-open level (including top level), and the current token's start (tokens include contiguous reader-prefix characters; record the `#_` marker separately so it can be stripped). At the cursor, decide per the rule order; when the answer needs text past the cursor (token continues, or enclosing form must close), continue scanning forward just until the token ends / the frame closes. Return `null` whenever the needed frame never closes. `nsBefore(text, offset)`: during the same kind of scan, remember the name symbol of every completed top-level list whose first token is `ns`; return the last one whose start precedes `offset`. Keep both functions pure (no vscode imports), documented, and shaped like the existing `indent.ts`/`maintainIndent.ts` modules.

- [x] **Step 4: Run tests to verify they pass**
  Run: `make test`
  Expected: PASS

- [x] **Step 5: Commit**
  `git commit -m "feat: add form-at-cursor and ns detection for REPL eval"`

### Task 2: nREPL client — eval params and load-file (`client.ts`)

**Files:**
- Modify: `src/nrepl/client.ts`
- Test: `src/test/nreplClient.test.ts`

- [x] **Step 1: Write failing tests**
  Using the fake nREPL server: `eval` with `{ ns: "foo.bar", file: "/p/a.clj", line: 3, column: 1 }` puts those keys on the wire message; `eval` without extras sends none of them; `loadFile("(ns a)", session, cb, { filePath: "/p/a.clj", fileName: "a.clj" })` sends `op: "load-file"` with `file`, `file-path`, `file-name`; `loadFile` without path extras omits `file-path`/`file-name`.

- [x] **Step 2: Run tests to verify they fail**
  Run: `make test`
  Expected: FAIL — `eval` drops extras / `loadFile` does not exist.

- [x] **Step 3: Implement**
  `eval(code, session, onMessage?, extra?: { ns?, file?, line?, column? })` spreads defined extras into the request. `loadFile(file, session, onMessage?, extra?: { filePath?, fileName? })` sends `{ op: "load-file", file, session, "file-path"?, "file-name"? }`. The fake server may need a `load-file` default behavior mirroring `eval`.

- [x] **Step 4: Run tests to verify they pass**
  Run: `make test`
  Expected: PASS

- [x] **Step 5: Commit**
  `git commit -m "feat: support eval source params and load-file op in nREPL client"`

### Task 3: connection manager — eval outcome and loadFile

**Files:**
- Modify: `src/repl/connectionManager.ts`
- Test: `src/test/connectionManager.test.ts`

- [x] **Step 1: Write failing tests**
  `eval("(+ 1 2)")` resolves with `{ value: "3", namespaceNotFound: false }` and still appends `in`/`value` transcript entries; an eval whose responses carry `err` chunks and `status: ["eval-error", "done"]` resolves with concatenated `err` and no value; a response with `status: ["namespace-not-found", "done"]` sets `namespaceNotFound: true`; `eval` passes `ns`/`file`/`line`/`column` through to the client (assert on the fake server's received message); `loadFile("(ns a) :done", { fileName: "a.clj", filePath: "/p/a.clj" })` appends an `info` entry containing `a.clj` (not the file content as `in`), streams `value` to the transcript, and resolves with the outcome.

- [x] **Step 2: Run tests to verify they fail**
  Run: `make test`
  Expected: FAIL

- [x] **Step 3: Implement**
  Add `EvalOptions` and `EvalOutcome` types. `eval(code, opts?)` keeps its current streaming behavior and additionally accumulates: last `value`, concatenated `err`, `namespaceNotFound` from any message's `status` array. `loadFile(content, opts)` mirrors `eval` but calls the client's `loadFile`, appends `{ kind: "info", text: "Loading <fileName ?? \"buffer\">…" }` first, and streams responses through the same `appendEvalMessage`. Existing callers (`eval(code)` in commands/tests) keep working — the return value is additive.

- [x] **Step 4: Run tests to verify they pass**
  Run: `make test`
  Expected: PASS

- [x] **Step 5: Commit**
  `git commit -m "feat: return eval outcomes and support load-file in connection manager"`

### Task 4: inline results manager (`inlineResults.ts`)

**Files:**
- Create: `src/repl/inlineResults.ts`
- Test: `src/test/inlineResults.test.ts`

- [x] **Step 1: Write failing tests for the pure helpers**
  Inline text formatting: first line only, 120-char cap with ellipsis, spaces → NBSP, ` => ` prefix. Hover markdown: contains a ```clojure fence with the full value and a `command:clojurePulse.copyEvalResult` link with the encoded result id. Range shifting (structural `{start, end}` line/character shapes, no vscode imports): edit entirely above shifts a result down/up by the line delta; edit entirely below leaves it; intersecting edit marks it dropped; multi-line replacement deltas.

- [x] **Step 2: Run tests to verify they fail**
  Run: `make test`
  Expected: FAIL — module does not exist.

- [x] **Step 3: Implement `InlineResultsManager`**
  Pure helpers first (exported), then the manager: three long-lived decoration types (pending/success/error) with `ThemeColor`s per the design, plus a flash type (`editor.wordHighlightBackground` background) applied on `markPending` and cleared via `setTimeout` ~200 ms. State per document uri; `markPending(editor, range)` drops any existing result ending on the same line, assigns an id, renders. `resolve(id, outcome)` picks error text (`err` first line; namespace-not-found message when flagged) or value, re-renders all decorations for editors showing that document. `onDidChangeTextDocument` applies the pure shifting helper per content change and re-renders; `onDidCloseTextDocument` drops state. `clearAll()`, `resultAt(uri, position)`, `latest()`, `dispose()` (clear timers and decoration types). Re-render also on `onDidChangeVisibleTextEditors` so results survive tab switches.

- [x] **Step 4: Run tests to verify they pass**
  Run: `make test`
  Expected: PASS

- [x] **Step 5: Commit**
  `git commit -m "feat: add inline eval result decorations"`

### Task 5: commands, setting, and wiring

**Files:**
- Modify: `package.json`
- Modify: `src/extension.ts`
- Test: `src/test/replCommands.integration.test.ts`

- [x] **Step 1: Write failing integration tests**
  After activation: `clojurePulse.evalCurrentForm`, `clojurePulse.evalFile`, `clojurePulse.clearInlineResults`, `clojurePulse.copyEvalResult` appear in `vscode.commands.getCommands()`. With the fake server connected: open a scratch Clojure document `(ns scratch)\n(+ 1 2)`, place the cursor inside `(+ 1 2)`, run `evalCurrentForm` → transcript gains `in` = `(+ 1 2)` and a `value` entry, the fake server received `ns: "scratch"`, and the exposed inline manager holds one resolved result; cursor in empty top-level whitespace of an empty doc → command resolves without throwing and sends nothing; `evalFile` → fake server receives a `load-file` op with the buffer content. Not-connected guard resolves without throwing (mirrors existing evalSelection test).

- [x] **Step 2: Run tests to verify they fail**
  Run: `make test`
  Expected: FAIL — commands not registered.

- [x] **Step 3: Add contributions to `package.json`**
  Commands (category "Clojure Pulse"): `evalCurrentForm` "Evaluate Current Form", `evalFile` "Evaluate File", `clearInlineResults` "Clear Inline Results", `copyEvalResult` "Copy Evaluation Result". Setting `clojurePulse.inlineEvalResults` (boolean, default `true`, markdownDescription explaining ghost-text results and the hover Copy link). No keybindings.

- [x] **Step 4: Wire in `extension.ts`**
  Instantiate `InlineResultsManager` in `setupRepl`, expose it on `ExtensionApi`, push into subscriptions. `evalCurrentForm`: connected guard (reuse the evalSelection pattern) → active editor guard → target = non-empty selection, else `formAtCursor` (status-bar message + return on `null`) → code + `nsBefore` + 1-based line/column + `file` for file-scheme docs → if setting on: `markPending` + eval + `resolve`; reveal the pane only when the setting is off. `evalFile`: connected guard → `loadFile(document.getText(), { filePath?, fileName? })` → reveal pane. `evalSelection`: unchanged flow plus `markPending`/`resolve` on the selection range when the setting is on. `clearInlineResults` / `copyEvalResult` (with optional id arg from the hover link; fallback to result at cursor, then latest; `vscode.env.clipboard.writeText`). Wrap eval rejections so a socket drop resolves the pending decoration to an error (inline results are intentionally not cleared on disconnect, so this failure stays visible).

- [x] **Step 5: Run tests to verify they pass**
  Run: `make test`
  Expected: PASS (all suites).

- [x] **Step 6: Commit**
  `git commit -m "feat: add eval current form and eval file commands with inline results"`

### Task 6: end-to-end check and docs

**Files:**
- Modify: `README.md`, `CHANGELOG.md`

- [x] **Step 1: Manual end-to-end verification**
  Against a real nREPL (`clj -M -m nrepl.cmdline`): eval a form mid-`defn` (flash + pending + green result inline, entry in pane), cursor right after a closing paren, a `#_`-discarded form, a form inside `(comment ...)`, a form in a namespaced file before loading it (namespace-not-found inline hint), "Evaluate File" then the form again (works), an exception (red inline first line, full trace in pane, hover shows it), long value (truncated inline, full in hover, Copy link works), edit the form (result clears), edit above it (result stays glued), toggle the setting off (pane-only, pane revealed), "Clear Inline Results". On a headless machine, replace GUI checks with test-host equivalents where possible and note the deviation in the completion summary.

- [x] **Step 2: Full check**
  Run: `make check`
  Expected: lint, compile, and tests all pass.

- [x] **Step 3: Update docs**
  README "REPL" section: the two new commands, form-selection rules in brief, inline results (hover/copy/clear, the setting), no default keybindings + an example custom keybinding snippet. CHANGELOG entry under the unreleased version.

- [x] **Step 4: Commit**
  `git commit -m "docs: document eval commands and inline results"`

---

## Completion Summary (2026-07-07)

All 6 tasks implemented and committed; `make check` passes with 195 tests
(45 new for `forms`, 20 for `inlineResults` helpers, plus client / manager /
command-wiring cases).

**What was built:**
- `src/repl/forms.ts` — pure `formAtCursor` (six-rule innermost-form
  resolution with reader-prefix / `#_` / `(comment …)` handling) and
  `nsBefore`, via a small recursive-descent reader that shares the robustness
  rules of `indent.ts`.
- `src/nrepl/client.ts` — `eval` now forwards `ns`/`file`/`line`/`column`;
  new `loadFile` sends the `load-file` op.
- `src/repl/connectionManager.ts` — `eval`/`loadFile` resolve with an
  `EvalOutcome` (`value` / concatenated `err` / `namespaceNotFound`) while
  still streaming to the transcript.
- `src/repl/inlineResults.ts` — `InlineResultsManager`: per-state ghost-text
  decorations, form flash, trusted-only Copy hover, edit-tracking (shift /
  drop), and pure helpers (`formatInlineText`, `buildHoverMarkdown`,
  `shiftRange`).
- `src/extension.ts` + `package.json` — `evalCurrentForm`, `evalFile`,
  `clearInlineResults`, `copyEvalResult` commands, the
  `clojurePulse.inlineEvalResults` setting (default on), and the wiring that
  marks/resolves inline results around each eval.

**Per-task codex reviews (all addressed):**
- forms: skip reader-prefixed `ns` forms; don't let incomplete code *after*
  the cursor block rule-6 walk-back — both fixed with regression tests.
- inlineResults: restrict hover `isTrusted` to the Copy command only; drop
  `byId`/`latestId` on document close; clear the prior editor's flash before
  replacing its timer — all fixed.
- commands: a mid-eval socket drop previously let disconnect's `clearAll()`
  race ahead of the failure decoration. Resolved by **not** clearing inline
  results on disconnect (nothing user-facing promised it, and Calva keeps them
  too); the pending decoration now resolves to the failure via `runEval`'s
  catch, and past results persist until edited or explicitly cleared.
- Tasks 2 and 3 reviews found no issues.

**Deviations from the plan:**
- Inline results are no longer cleared on disconnect (see above); the plan's
  lifecycle/error-handling notes were updated to match.
- Namespace-not-found relies on nREPL's `status: ["namespace-not-found"]`.
  This machine is headless, so the two GUI checks were replaced with an
  end-to-end smoke run (`scripts/e2e-eval-smoke.mjs`) driving the compiled
  modules against a real Babashka nREPL, plus a JVM nREPL (Clojure 1.12)
  check: form-at-cursor eval in the detected namespace, `load-file`, an
  exception surfacing as `err`, and namespace-not-found all verified. (Only
  the JVM server emits the `namespace-not-found` status; Babashka returns a
  plain `err`, so that one assertion is JVM-only — expected, since clj-pulse
  targets JVM Clojure.) The GUI decoration rendering itself is covered
  structurally by the manager tests and the command integration tests; an F5
  smoke test on a desktop is still worthwhile.
- The final confirming codex pass over the disconnect fix could not run (codex
  usage limit); the change is a single-branch removal fully covered by the
  passing suite.
