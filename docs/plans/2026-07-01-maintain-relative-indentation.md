# Maintain relative indentation (Cursive-style) — child lines follow their anchor

> **For agentic workers:** Use executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When an edit on one line horizontally moves code that later lines are structurally anchored to, shift those lines' leading whitespace by the same delta — automatically, as you type, like IDEA Cursive. Motivating cases:

1. **Spaces before the opener of a multiline form** — typing/deleting spaces before `(defn f` shifts the body lines right/left by the same amount.
2. **Newline inserted right before a bracket** — Enter before `(foo …` (multiline) moves the opener to a new line at the indent-on-Enter column; the form's body lines follow it instead of staying behind, visually breaking the form.
3. **Head symbol grows/shrinks** — renaming `->` to `cond->` where following lines are *argument-aligned* shifts the aligned lines so they stay aligned (Task 3's alignment extension; lines at plain 2-space body indent correctly do **not** move).
4. **Typing before a nested multiline form on the same line** — editing `foo` in `(foo (bar\n      baz))` keeps `baz` aligned under `bar` live, keystroke by keystroke.

**Tech Stack:** TypeScript (VS Code extension). Extends the `src/indent.ts` scanner from the indent-on-Enter plan (`docs/plans/2026-07-01-indent-on-enter-client-side.md`). No new runtime deps.

**Prerequisites:** Plan B-client's Task 1 (`src/indent.ts` scanner) must exist — this plan adds a forward-scan mode to the same tokenizer. Works with either Plan A (server onTypeFormatting) or Plan B (client Enter): the listener reacts to *all* document changes, including those made by `clojurePulse.newline` (only its own shift edits are guarded out). With Plan A's async Enter the newline-before-bracket case settles in two visible steps; with Plan B's atomic Enter it's one keystroke + one immediate shift.

---

## Design

### Semantics: preserve *relative* indentation, never reformat

This feature is **not** reindent/format. We never recompute the canonical indent of untouched lines; we *translate* them by exactly the horizontal distance their anchor moved. Manually aligned code stays aligned; oddly indented code stays odd — just shifted. (This matches Cursive's feel and is why the feature is trustworthy: it can only preserve structure, not impose style.)

**Anchor:** for line *i*, the innermost bracket still open at the start of line *i* (the same notion the indent-on-Enter scanner uses).

**Which lines shift (cascade rule):** a line shifts by the amount its anchor's position moved:
- an anchor sitting on the edited line at/after the edit point moved by `delta`;
- an anchor sitting on a line that this pass shifts by `s` moved by `s`.

Computed top-down this is a single pass: whole lines shift as units, so nested relative indentation inside a shifted region is preserved for free; only *direct* children of unmoved anchors stay put.

**Edit delta (uniform for single- and multi-line edits):** for a content change replacing `range` with `text`, the tail of the edited line (everything that was after `range.end`) lands at:

```
newCol = text.includes("\n") ? lengthOfLastLine(text) : range.start.character + text.length
oldCol = range.end.character
delta  = newCol - oldCol
tailLine = range.start.line + countNewlines(text)   // post-edit line holding the moved tail
```

This one formula covers typing (case 1/4), deletion, Enter-before-bracket (case 2 — `text` is `"\n" + indent`, so `newCol = indent.length`), and line-joins.

**Shift extent:** post-edit, run the prefix scanner to the tail position, then continue a forward scan to the end of `tailLine`. The *affected* brackets are those open at end of `tailLine` that were opened on `tailLine` at column ≥ `newCol` (they form a suffix of the stack — stack columns increase left-to-right). Take the shallowest affected bracket and keep scanning forward until it closes; shift lines from `tailLine + 1` through its closing line. If it **never closes** (unbalanced mid-typing, e.g. a bare `(` without auto-close) → do nothing; never shift the rest of the file on a guess.

### Alignment-anchor extension (case 3, the `->` → `cond->` rename)

When the edit is inside the head of a `(`-form whose **opener did not move** but whose **first argument did** (it sits after the edit on the tail), bracket anchors alone see nothing to do — yet argument-aligned lines should follow the first argument. Extension: let `F` be the innermost form enclosing the edit point (only `F` needs this check — every outer form's first element starts at or before `F`'s opener, hence before the edit). If `F`'s opener is before the edit and its first argument is on the tail (so it moved by `delta`), then lines whose anchor is `F` **and** whose current indent column equals the first argument's *old* column (`newFirstArgCol - delta`) shift by `delta`; their cascade (anchors on those lines) follows the normal rule. Lines at other columns — e.g. the 2-space body indent this extension's Enter rule produces — don't move, so `let` → `letfn` leaves a 2-space body alone while `(-> foo\n    bar)` → `(cond-> foo\n        bar)` works like Cursive.

### Guards — every one bails to "do nothing" (the feature must never corrupt)

- document not `clojure`, or no visible editor for it.
- `event.reason` is Undo/Redo — the shift is merged into the user's undo step (below), so the undo already restores everything; reacting again would double-apply.
- `event.contentChanges.length !== 1` — multi-cursor typing, format-on-save, big refactors: bail in v1 (note as follow-up; bailing is just today's status quo, never corruption).
- re-entrancy: our own shift edit fires the listener — ignore it via a module-level in-flight flag.
- edit end is inside a string or comment (scanner tells us), or `delta === 0`, or no affected bracket and no alignment match.
- affected bracket unclosed, or extent > 1000 lines (perf/safety cap — `log`/silently skip).
- per-line skips inside the extent: lines whose start is inside a **multiline string** (shifting them changes the string's value), empty/whitespace-only lines, lines with tabs in their leading whitespace (never guess tab width). Clamp resulting indent at column 0.

### Applying the shift

One `editor.edit` over all lines: insert `delta` spaces at column 0, or delete `min(-delta, existingLeadingSpaces)`. Pass `{ undoStopBefore: false, undoStopAfter: false }` so the shift merges into the user's typing undo group — a single Ctrl+Z reverts keystroke *and* shift together (which is also what makes the Undo guard above sound).

### Parinfer overlap

Parinfer's Smart Mode implements exactly this behavior. Running both would double-shift. Add `clojurePulse.maintainIndentation` (boolean, default `true`) and document in README: Parinfer users should disable one of the two.

### Components & structure

```
clojure-pulse-vscode/
├─ src/indent.ts             EXTEND — expose tokenizer core; add forward scan:
│                              matching-close lookup + per-line {anchor, inString, indentCol} events
├─ src/maintainIndent.ts     NEW — pure planShift(postText, change) -> {line, deltaCols}[] | null
├─ src/extension.ts          MODIFY — onDidChangeTextDocument listener + guards + edit application
├─ package.json              MODIFY — clojurePulse.maintainIndentation setting
└─ src/test/maintainIndent.test.ts  NEW — unit tests for planShift
```

`planShift` is pure and takes only the **post-edit** text plus the change metadata (`range`, `text`) — the deltas and old columns are all derivable without the pre-edit text, so no document snapshotting is needed.

### Testing

- **Unit** (`maintainIndent.test.ts`): the four motivating cases; nested cascade (shifted line carrying an anchor shifts its own children); shift-left via deletion; clamp at 0; unbalanced-opener bail; edit-inside-string bail; multiline-string lines skipped inside a shifted extent; alignment extension (aligned lines follow, 2-space body doesn't, `let`→`letfn` no-op); multi-line insert (Enter-before-bracket) and line-join deltas.
- **Integration** (Extension Host): apply a typing edit to a real `clojure` document, await the listener, assert the shifted buffer; assert a single undo restores the original text; assert `maintainIndentation: false` disables it.
- Run headless via `xvfb-run -a npm test`.

## Tasks

### Task 1: Forward-scan support in the scanner (TDD)

**Files:**
- Modify: `src/indent.ts`, `src/test/indent.test.ts`

- [ ] **Step 1: Write failing unit tests**
  For the new scan API: matching-close position for a given opener offset (`(a [b\n c]\n d)` — close of `[` and of `(`); `null` when unclosed; per-line info over a range (anchor identity, whether the line starts inside a string — cover a multiline string spanning 3 lines); comments/regex/char-literals still skipped in forward mode.

- [ ] **Step 2: Run tests to verify they fail**
  Run: `npm test`

- [ ] **Step 3: Implement**
  Refactor `indent.ts` so the character-classification + stack-transition core is a reusable generator/callback scan; `indentColumnAt` becomes a thin consumer. Add `scanForward` producing, per line: `{ line, indentCol, anchor (opener offset|null), startsInString }`, and matching-close lookup. UTF-16 columns throughout.

- [ ] **Step 4: Run tests to verify they pass, lint, commit**
  Run: `npm test && npm run lint`
  `git commit -m "feat: forward structural scan (matching close, per-line anchors)"`

### Task 2: Pure shift planner (TDD)

**Files:**
- Create: `src/maintainIndent.ts`, `src/test/maintainIndent.test.ts`

- [ ] **Step 1: Write failing unit tests**
  `planShift(postText, {range, text})` returns `{line, deltaCols}[]` (empty = nothing to do, `null` = bail). Cover: cases 1, 2, 4 from the Goal; deletion (negative delta); cascade through a nested form; clamp at 0; skip string-interior and tab-indented lines; bail on unclosed affected bracket, in-string edit, `delta === 0`, extent cap.

- [ ] **Step 2: Run tests to verify they fail**
  Run: `npm test`

- [ ] **Step 3: Implement**
  The Design algorithm: delta formula → prefix scan to tail → affected-suffix detection → forward scan to shallowest affected close → top-down per-line shift via the cascade rule.

- [ ] **Step 4: Run tests to verify they pass, lint, commit**
  Run: `npm test && npm run lint`
  `git commit -m "feat: relative-indentation shift planner"`

### Task 3: Alignment-anchor extension (TDD)

**Files:**
- Modify: `src/maintainIndent.ts`, `src/test/maintainIndent.test.ts`

- [ ] **Step 1: Write failing unit tests**
  `(-> foo\n    bar\n    baz)` + rename to `cond->` → both lines shift +4; same doc with 2-space body → no shift; `(let …)` → `(letfn …)` with 2-space body → no shift; aligned line whose own nested form spans further lines → cascade shifts those too; edit *after* the first argument → no alignment shift.

- [ ] **Step 2: Run tests to verify they fail**
  Run: `npm test`

- [ ] **Step 3: Implement**
  Per Design: innermost form only; opener before edit, first argument on the moved tail; match lines anchored to it at indent `== newFirstArgCol - delta`.

- [ ] **Step 4: Run tests to verify they pass, lint, commit**
  Run: `npm test && npm run lint`
  `git commit -m "feat: follow argument alignment when a head symbol resizes"`

### Task 4: Listener wiring + setting

**Files:**
- Modify: `src/extension.ts`, `package.json`

- [ ] **Step 1: Listener**
  In `activate` (near `setupIgnoredFormDimming`): subscribe `workspace.onDidChangeTextDocument`; apply the Design guards (language, reason, single change, in-flight flag, setting); call `planShift`; apply via `editor.edit(…, { undoStopBefore: false, undoStopAfter: false })` on a visible editor for the document, wrapped in the in-flight flag.

- [ ] **Step 2: Setting**
  Add `clojurePulse.maintainIndentation` (boolean, default `true`, markdownDescription mentioning the Parinfer overlap) to `contributes.configuration`.

- [ ] **Step 3: Compile + manual check**
  Run: `npm run compile`, then F5: type spaces before a multiline `(defn` (body follows live); Enter before a bracket (form stays intact); rename `->`→`cond->` in an aligned thread (stays aligned); one Ctrl+Z fully reverts each; typing inside a multiline string moves nothing.

- [ ] **Step 4: Commit**
  `git commit -m "feat: maintain relative indentation while editing"`

### Task 5: Integration tests + docs

**Files:**
- Modify: `src/test/` (new integration test), `README.md`

- [ ] **Step 1: Integration tests**
  Extension Host: open an untitled `clojure` doc, make a single-character typing edit before a multiline form via `TextEditor.edit`, await the follow-up shift, assert the buffer; assert one `undo` command restores the pre-typing text; assert no shift when `clojurePulse.maintainIndentation` is `false`.

- [ ] **Step 2: Run tests**
  Run: `xvfb-run -a npm test`

- [ ] **Step 3: Docs**
  README: describe the feature with a small before/after, the setting, the Parinfer Smart Mode overlap (disable one), and the v1 limits (single-change edits only; tab-indented lines untouched).

- [ ] **Step 4: Commit**
  `git commit -m "test+docs: maintain relative indentation"`
