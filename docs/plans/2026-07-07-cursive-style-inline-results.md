# Cursive-Style Inline Results + Hide on Escape Implementation Plan

> **For agentic workers:** Use executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render inline evaluation results at the end of the line (never between brackets) in a muted Cursive-like style, and let the user hide them by pressing Escape.

**Tech Stack:** TypeScript, VS Code extension API (TextEditorDecorationType `after` ghost text, `setContext` context keys, keybindings), mocha via `@vscode/test-cli`.

---

## Design

### Background

Inline results shipped in `2026-07-06-eval-inline-results.md` anchor the ghost-text decoration to the **evaluated form's** range, so the `after` text renders immediately after the form's closing bracket. For a nested or mid-line form (e.g. evaluating `(:a d)` inside `(comment (let …))`) the result lands *between brackets*, mid-code — the behavior the user dislikes about Calva. This change moves the result to the end of the line and restyles it to match Cursive, and adds an Escape binding to hide results on demand.

Reference (Cursive): the result value is shown at the **end of the line**, in a **muted grey italic**, separated from the code by a whitespace gap, with **no `=>` prefix** — just the bare value. Errors are shown in red. (Cursive's persistent bracket/gutter decorations are explicitly out of scope here — see Non-goals.)

### What changes

1. **End-of-line rendering.** The decoration's *render* range becomes `form.start → end of the form's last line`, so the `after` ghost text attaches at the end of the line, after all code — never between brackets. The form's own range is still stored and used for edit-tracking (shift/drop), copy-at-cursor, and the existing flash; only the rendered decoration range is derived to end-of-line. The hover (full value + Copy link) now covers the form through the line end, an easy target.

2. **Cursive-style styling.** Drop the `=>` prefix — the inline text is just the (first line, capped, NBSP-escaped) value; a left `margin` on the decoration provides the gap from the code. Pending shows a bare `…`. Colors: pending and success use the theme's inlay-hint grey (`editorInlayHint.foreground`); errors keep `errorForeground`. Text stays italic.

3. **Hide on Escape.** A new context key `clojurePulse.hasInlineResults` tracks whether any inline results are currently shown; the manager updates it on every mutation. A keybinding maps `escape` to the existing `clojurePulse.clearInlineResults` command, gated so it only intercepts Escape when results exist and no higher-priority Escape consumer is active.

### Non-goals (deliberate, separate future work)

- No gutter marker / bulb.
- No bracket or persistent form highlighting. The existing ~200 ms eval **flash** is left exactly as-is; no new highlighting is added.
- No change to the persistence model (results still stay until the form is edited, "Clear Inline Results" runs, the document closes, or — now — Escape), one-result-per-line, truncation, hover/Copy, or the `clojurePulse.inlineEvalResults` setting.

### Components

- **`src/repl/inlineResults.ts`:**
  - New pure helper `renderRange(formRange: SimpleRange, endLineLength: number): SimpleRange` — returns `{ start: formRange.start, end: { line: formRange.end.line, character: endLineLength } }`. Unit-tested.
  - `formatInlineText(value)` — drop the ` => ` prefix; return the first line, capped at 120 with an ellipsis, spaces → NBSP (unchanged otherwise).
  - `toOptions(doc, result)` — now takes the document; computes the render range via `renderRange(result.range, doc.lineAt(endLine).range.end.character)` with `endLine` clamped to `doc.lineCount - 1`; pending `contentText` becomes `…`.
  - Decoration types recolored: `pendingType` and `successType` → `editorInlayHint.foreground`; `errorType` → `errorForeground`; add `after.margin` (≈ `0 0 0 2ch`) for the code gap; keep `fontStyle: italic`.
  - `hasResults(): boolean` accessor (`byId.size > 0`).
  - `updateContext()` — `vscode.commands.executeCommand("setContext", "clojurePulse.hasInlineResults", this.byId.size > 0)`; called at the end of `markPending`, `clearAll`, `onEdit` (after survivors are set), and `forget`, plus once in `dispose()` to reset it false.
- **`package.json`:** one `escape` keybinding → `clojurePulse.clearInlineResults`.
- **`README.md` / `CHANGELOG.md`:** document end-of-line rendering and Escape-to-hide.

### Error handling

- `toOptions` clamps `endLine` to a valid line so a result whose stored range briefly outruns the document (mid-edit) never throws; `doc.lineAt` is only called with an in-range line.
- Escape keybinding `when` excludes the common Escape consumers (`suggestWidgetVisible`, `renameInputVisible`, `parameterHintsVisible`, `findWidgetVisible`, `inSnippetMode`, `editorHasSelection`) so it never steals Escape from IntelliSense, rename, find, snippets, or deselect; when no results exist the key isn't bound at all.

### Testing strategy

- Unit-test `renderRange` (single-line → same line, end char = line length, start unchanged; multi-line → end on the form's last line).
- Update the `formatInlineText` unit tests to the prefix-free output.
- Integration (VS Code host, fake nREPL): after `evalCurrentForm`, `api.inlineResults.hasResults()` is `true`; after the `clojurePulse.clearInlineResults` command, it is `false`. Existing command/transcript assertions stay.
- The manager's edit-tracking, shift, and copy tests are unaffected (the stored range is still the form).

## File Structure

```
src/
  repl/
    inlineResults.ts        # MODIFY: renderRange helper, end-of-line toOptions, restyle, context key
  test/
    inlineResults.test.ts   # MODIFY: renderRange tests, prefix-free formatInlineText tests
    replCommands.integration.test.ts  # MODIFY: hasResults toggles on eval / clear
package.json                # MODIFY: escape keybinding
README.md, CHANGELOG.md     # MODIFY: docs
```

---

### Task 1: End-of-line Cursive-style rendering

**Files:**
- Modify: `src/repl/inlineResults.ts`
- Test: `src/test/inlineResults.test.ts`

- [ ] **Step 1: Update/extend the failing tests**
  In `inlineResults.test.ts`: change the `formatInlineText` expectations to the prefix-free form — `formatInlineText("42")` → `"42"`; the "keeps only the first line" and "replaces every space" cases lose the `${NBSP}=>${NBSP}` prefix (value still NBSP-escaped); the truncation case asserts the whole return is 120 chars ending in `…`. Add a `renderRange` suite: a single-line form `{start:{0,3},end:{0,8}}` with `endLineLength` 15 → `{start:{0,3},end:{0,15}}`; a multi-line form `{start:{0,0},end:{2,4}}` with `endLineLength` 10 → end `{2,10}`, start unchanged.

- [ ] **Step 2: Run tests to verify they fail**
  Run: `make test`
  Expected: FAIL — `renderRange` missing and `formatInlineText` still prefixes ` => `.

- [ ] **Step 3: Implement**
  Add the pure `renderRange` helper. Drop the ` => ` prefix from `formatInlineText` (keep first-line/cap/NBSP). Change `toOptions` to `toOptions(doc, result)`: clamp `endLine = Math.min(result.range.end.line, doc.lineCount - 1)`, compute the render range with `renderRange` and `doc.lineAt(endLine).range.end.character`, use it as the decoration `range`; pending `contentText` = `…`. Update the `render` loop to pass `doc`. Recolor the decoration types (pending/success → `editorInlayHint.foreground`, error → `errorForeground`), add `after.margin` for the gap, keep italic. Leave the flash and all stored-range logic untouched.

- [ ] **Step 4: Run tests to verify they pass**
  Run: `make test`
  Expected: PASS

- [ ] **Step 5: Commit**
  `git commit -m "feat: render inline eval results at end of line, Cursive-style"`

### Task 2: Hide inline results on Escape

**Files:**
- Modify: `src/repl/inlineResults.ts`
- Modify: `package.json`
- Test: `src/test/replCommands.integration.test.ts`

- [ ] **Step 1: Write the failing test**
  In `replCommands.integration.test.ts`, connect to the fake nREPL, open a Clojure doc, run `evalCurrentForm` on a form, assert `api.inlineResults.hasResults() === true`; then `await vscode.commands.executeCommand("clojurePulse.clearInlineResults")` and assert `hasResults() === false`.

- [ ] **Step 2: Run tests to verify they fail**
  Run: `make test`
  Expected: FAIL — `hasResults` does not exist.

- [ ] **Step 3: Implement**
  Add `hasResults()` and a private `updateContext()` (sets `clojurePulse.hasInlineResults` via `setContext` to `byId.size > 0`); call `updateContext()` at the end of `markPending`, `clearAll`, `onEdit`, and `forget`, and once in `dispose()` (false). In `package.json` add a `keybindings` entry: `escape` → `clojurePulse.clearInlineResults`, `when` = `editorTextFocus && editorLangId == clojure && clojurePulse.hasInlineResults && !suggestWidgetVisible && !renameInputVisible && !parameterHintsVisible && !findWidgetVisible && !inSnippetMode && !editorHasSelection`.

- [ ] **Step 4: Run tests to verify they pass**
  Run: `make test`
  Expected: PASS

- [ ] **Step 5: Commit**
  `git commit -m "feat: hide inline eval results on Escape"`

### Task 3: Docs and verification

**Files:**
- Modify: `README.md`, `CHANGELOG.md`

- [ ] **Step 1: Update docs**
  README inline-results bullet: results now render at the end of the line in a muted style (not between brackets), and Escape hides them. CHANGELOG: entry under the unreleased version noting end-of-line Cursive-style rendering and Escape-to-hide.

- [ ] **Step 2: Full check**
  Run: `make check`
  Expected: lint, compile, and tests all pass.

- [ ] **Step 3: Manual/e2e sanity**
  On a desktop (F5), or note the headless deviation: eval a nested form inside `(comment (let …))` and confirm the result shows at the end of the line (not between brackets), muted, no `=>`; eval an error and confirm it shows red; press Escape and confirm the results clear while Escape still works normally (deselect, close suggest widget) when no results are shown. The existing `scripts/e2e-eval-smoke.mjs` still passes for the eval wire behavior.

- [ ] **Step 4: Commit**
  `git commit -m "docs: document end-of-line inline results and Escape-to-hide"`
