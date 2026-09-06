# Evaluate Top Form Implementation Plan

> **For agentic workers:** Use executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a command, **Evaluate Top Form**, that evaluates the top-level form containing the cursor in the active REPL, descending one level into `(comment …)` forms.

**Tech Stack:** TypeScript VS Code extension, pure-text form reader in `src/repl/forms.ts`, Mocha unit and integration tests via `@vscode/test-cli` with the fake nREPL server.

---

## Design

### Problem

**Evaluate Current Form** picks the innermost form at the cursor. To
re-evaluate a whole `defn` from somewhere inside its body, the user has to
move the cursor to the closing paren first. Every Clojure editor offers a
second command for this: Cursive's *Send top form to REPL*, Calva's
*Evaluate Top Level Form*. Clojure Pulse has none.

### Behaviour

`clojurePulse.evalTopForm`, titled **Evaluate Top Form**, resolves a form
from the active cursor and evaluates it exactly as Evaluate Current Form
would evaluate a selection of the same text.

Resolution rules, in order:

| Cursor | Form sent |
|---|---|
| inside a top-level form (start ≤ cursor ≤ end) | that whole form |
| in top-level whitespace after a form | the previous top-level form, so "right after the closing paren" works |
| in top-level whitespace before the first form, or in a blank buffer | nothing; status bar says `Clojure Pulse: no form found at cursor` |
| inside a top-level `(comment …)`, after its `(` and no later than its `)`, on or after a body form | the body form containing the cursor, or the previous body form when in whitespace |
| on the `comment` symbol, or anywhere before the first body form | the whole `(comment …)` form |
| the top-level form never closes (unbalanced) | nothing, same message |

Details that follow existing commands:

- **Prefixes.** Leading `#_` markers are stripped from the sent range, as
  `formAtCursor` does, so evaluating a discarded form yields its value.
  Quote-like prefixes and `^meta` stay part of the text.
- **Comment descent** is one level only, and only when the head token is
  exactly `comment` and the form has no reader prefix. `#_(comment …)` is
  sent whole once its marker is stripped. Nested comments are not descended.
- **Selection is ignored.** The command always resolves from
  `editor.selection.active`. Evaluate Current Form is the selection-aware
  command.
- **Namespace and output.** `nsBefore` supplies the file's namespace, the
  inline result appears at the end of the sent range, and the output channel
  is revealed only when inline results are off. Same as Evaluate Current Form.
- **Surface.** Listed in the command palette, no default keybinding, same as
  the other eval commands.

### Implementation shape

**`src/repl/forms.ts`.** `testAtCursor` already walks top-level forms with
the first three rules above. Extract that loop into a private
`readTopFormAtCursor(text, offset): ReadForm | null` and call it from
`testAtCursor`. The new export builds on it:

```ts
export function topFormAtCursor(text: string, offset: number): FormRange | null;
```

It reads the top form, and if that form is a comment list with
`bracketOffset < offset <= closerOffset` (the position right before the `)`
still counts as inside), resolves among the body forms with the same
containing-or-previous rule: a small sibling walk using `readForm` over
`[headEnd, closerOffset)`, where `headEnd` is the end of the `comment`
token. The head is never a candidate, so a cursor on `comment` or in the gap
after it has no previous body form and falls back to the whole comment form.
The cursor's own unbalanced child yields null like `resolveIn` does. The
result is `stripped(form)`.

A form is a comment list when `bracketOffset` is a `(`, `baseStart === start`
(no prefixes at all), and the first child read by `readForm` is an atom
whose text is `comment`.

**`src/extension.ts`.** `evalCurrentForm` ends with a tail shared by the new
command: compute the code and namespace from a range, reveal the output
channel when inline results are off, call `runEval`. Extract it:

```ts
async function evalRange(
  session: ReplSessionLike,
  inlineResults: InlineResultsManager,
  editor: vscode.TextEditor,
  range: vscode.Range,
): Promise<void>;
```

`evalCurrentForm` resolves its range (selection or `formAtCursor`) and calls
`evalRange`. The new `evalTopForm(registry, inlineResults)` mirrors it with
`topFormAtCursor` and no selection branch. Both report the same status-bar
message when nothing resolves.

**`package.json`.** One entry under `contributes.commands`, right after
`clojurePulse.evalCurrentForm`. No `commandPalette` entry (visible by
default), no keybinding.

### Testing

- `src/test/forms.test.ts`: a `topFormAtCursor` suite using the same `|`
  cursor helper as the `formAtCursor` suites.
- `src/test/replCommands.integration.test.ts`: the command evaluates the
  whole `defn` from deep inside it, in the file's namespace, with the inline
  result; and sends nothing when no form resolves.
- `src/test/manifest.test.ts`: `PALETTE` gains the new id, which pins the
  command as visible.
- Existing `testAtCursor` suites guard the walker extraction.

## File Structure

- Modify: `src/repl/forms.ts` — add `readTopFormAtCursor` (private) and
  `topFormAtCursor` (export); `testAtCursor` uses the former.
- Modify: `src/extension.ts` — add `evalRange` helper and `evalTopForm`;
  register the command; import `topFormAtCursor`.
- Modify: `package.json` — contribute `clojurePulse.evalTopForm`.
- Modify: `src/test/forms.test.ts` — `topFormAtCursor` suite.
- Modify: `src/test/replCommands.integration.test.ts` — two command tests,
  plus the id in the "registers the REPL commands" list.
- Modify: `src/test/manifest.test.ts` — `PALETTE` entry.
- Modify: `README.md` — Evaluating section and command list.

Test commands used below:

```bash
npm run compile-tests && npx vscode-test --grep "<pattern>"
```

`npm test` runs the whole suite (scripts, compile, lint, then vscode-test).

## Tasks

### Task 1: Extract the top-level walker from `testAtCursor`

**Files:**
- Modify: `src/repl/forms.ts`
- Test: `src/test/forms.test.ts` (existing suites)

- [ ] **Step 1: Extract `readTopFormAtCursor`**
  Move the loop body of `testAtCursor` (clamp, walk top-level forms, skip
  stray closers, return null on unbalanced, pick containing-or-previous) into
  a private `readTopFormAtCursor(text: string, offset: number): ReadForm | null`.
  `testAtCursor` becomes: read the top form, return
  `form === null ? null : resolveDeftest(text, form)`. Keep the existing
  doc comments; the walker's comment should state the rules in the table
  above (containing form, else previous form, null before the first form or
  on unbalanced code).

- [ ] **Step 2: Run the existing form tests**
  Run: `npm run compile-tests && npx vscode-test --grep "testAtCursor|testsInText|formAtCursor"`
  Expected: PASS, no change in count.

- [ ] **Step 3: Commit**
  `git commit -am "Extract the top-level form walker from testAtCursor"`

### Task 2: `topFormAtCursor` resolver

**Files:**
- Modify: `src/repl/forms.ts`
- Test: `src/test/forms.test.ts`

- [ ] **Step 1: Write the failing tests**
  Add a `suite("topFormAtCursor", …)` with a `top(text)` helper mirroring
  the file's `form(text)` helper (cursor at `|`, returns the sliced text or
  null). Cases:
  - `(defn f [x]\n  (+ x |1))` → the whole defn
  - `(defn f [x] 1)|\n(g)` → `(defn f [x] 1)` (right after the closer)
  - `(a)\n  |\n(b)` → `(a)` (top-level whitespace, previous form)
  - `  |  (a)` → null (before the first form)
  - `|` on empty text → null
  - `(a) (b |` → null (unbalanced)
  - `#_(defn f [] |1)` → `(defn f [] 1)` (marker stripped)
  - `'(a |b)` → `'(a b)` (quote kept)
  - `(comment\n  (+ 1 |2)\n  (foo))` → `(+ 1 2)`
  - `(comment (+ 1 2)| (foo))` → `(+ 1 2)` (right after a child)
  - `(comment (+ 1 2)\n  |\n  (foo))` → `(+ 1 2)` (whitespace, previous child)
  - `(comm|ent (foo))` → `(comment (foo))`
  - `(comment |  (foo))` → `(comment   (foo))` (gap before the first body form)
  - `(comment\n  |\n  (foo))` → the whole form (whitespace before the first body form)
  - `(comment |(foo))` → `(foo)` (cursor at a child's start counts as inside)
  - `(comment (a) |)` → `(a)`
  - `(comment (a (b |c)))` → `(a (b c))` (one level only)
  - `(comment (comment |x))` → `(comment x)` (not recursive)
  - `#_(comment |x)` → `(comment x)` (prefixed comment is not descended)
  - `(clojure.core/comment |x)` → whole form (head must be bare `comment`)
  - `(comment (a |` → null (unbalanced child)

- [ ] **Step 2: Run to verify they fail**
  Run: `npm run compile-tests && npx vscode-test --grep "topFormAtCursor"`
  Expected: compile error, `topFormAtCursor` is not exported.

- [ ] **Step 3: Implement `topFormAtCursor`**
  Export it right after `formAtCursor`. Read the top form via
  `readTopFormAtCursor`; if it is a comment list (see design) and
  `bracketOffset < offset <= closerOffset`, walk the body forms from the end
  of the `comment` head token to `closerOffset`: skip stray closers, return
  null on an unbalanced child, track `prev`, return the child with
  `start <= offset <= end`, else `prev`, else the comment form itself. The
  head token is excluded from the walk, which is what makes the whole-form
  fallback work for a cursor on or right after `comment`. Return `stripped(...)` of whatever resolved. Doc
  comment states the rules and points to the README.

- [ ] **Step 4: Run to verify they pass**
  Run: `npm run compile-tests && npx vscode-test --grep "topFormAtCursor|testAtCursor|formAtCursor"`
  Expected: PASS.

- [ ] **Step 5: Commit**
  `git commit -am "Resolve the top-level form at the cursor"`

### Task 3: The command

**Files:**
- Modify: `src/extension.ts`
- Modify: `package.json`
- Modify: `src/test/manifest.test.ts`
- Modify: `src/test/replCommands.integration.test.ts`

- [ ] **Step 1: Write the failing tests**
  In `manifest.test.ts`, add `"clojurePulse.evalTopForm"` to `PALETTE` after
  `evalCurrentForm`. In `replCommands.integration.test.ts`, add the id to the
  "registers the REPL commands" list, then two tests modelled on the
  `evalCurrentForm` ones:
  - "evalTopForm evaluates the enclosing top-level form in its namespace":
    content `(ns scratch)\n(defn f [x]\n  (+ x 41))\n(f 1)`, cursor inside
    `41`; expect an `in` transcript entry equal to the whole defn text, the
    eval message's `ns` to be `scratch`, and `api.inlineResults.latest()` to
    be whatever the fake server returns for that code (check
    `fakeNreplServer.ts` for how it answers; use `(+ 1 2)` inside the defn
    body if the fake only knows fixed expressions).
  - "evalTopForm ignores the selection": same content, select the `41`
    token; expect the `in` entry to be the whole defn, not `41`.
  - "evalTopForm with no form at the cursor sends nothing": blank buffer,
    assert no `eval` op was received.

- [ ] **Step 2: Run to verify they fail**
  Run: `npm run compile-tests && npx vscode-test --grep "manifest|REPL commands"`
  Expected: FAIL, the palette assertion and the command registration test.

- [ ] **Step 3: Contribute the command**
  In `package.json`, add after `clojurePulse.evalCurrentForm`:
  `{ "command": "clojurePulse.evalTopForm", "title": "Evaluate Top Form", "category": "Clojure Pulse" }`.

- [ ] **Step 4: Extract `evalRange` and add `evalTopForm`**
  In `src/extension.ts`, import `topFormAtCursor`. Move the tail of
  `evalCurrentForm` (from `const code = …` to the `runEval` call) into
  `evalRange` with the signature in the design. `evalCurrentForm` keeps its
  selection-or-`formAtCursor` resolution and calls `evalRange`. Add
  `evalTopForm(registry, inlineResults)`: active session, active editor,
  `topFormAtCursor` on the document text at the active cursor offset, the
  "no form found at cursor" status message on null, then `evalRange`. Register
  it next to `evalCurrentForm` in the command registrations. Doc comment on
  `evalTopForm` names the selection decision.

- [ ] **Step 5: Run the tests**
  Run: `npm run compile-tests && npx vscode-test --grep "manifest|REPL commands"`
  Expected: PASS.

- [ ] **Step 6: Commit**
  `git commit -am "Add Evaluate Top Form command"`

### Task 4: README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Document the command**
  In the *Evaluating* section, add an **Evaluate Top Form** bullet after
  **Evaluate Current Form**: the top-level form around the cursor (or the one
  ending just before it), `#_` unwrapped, evaluated in the file's namespace;
  inside a `(comment …)` block the form directly under `comment` counts as
  top level, so rich comment forms evaluate one at a time; the selection is
  ignored. In the command list, add
  **Clojure Pulse: Evaluate Top Form** after Evaluate Current Form with a
  one-line description. Use /writing-clearly.

- [ ] **Step 2: Commit**
  `git commit -am "Document Evaluate Top Form"`

### Task 5: Full verification

- [ ] **Step 1: Run the whole suite**
  Run: `npm test`
  Expected: scripts tests, tsc, esbuild, eslint and vscode-test all pass.

- [ ] **Step 2: Fix anything that fails and commit**
