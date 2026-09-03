# Indent on Paste Implementation Plan

> **For agentic workers:** Use executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pasting a multi-line Clojure form lands every pasted line at the right column, preserving the form's internal layout, through a `DocumentPasteEditProvider` backed by the active formatting engine; and a newline that bypasses the extension's Enter keybinding is still reindented by the engine.

**Tech Stack:** TypeScript, VS Code extension API (`languages.registerDocumentPasteEditProvider`, finalized in VS Code 1.97), the existing `Scanner` / `FormattingEngine` cores, Mocha via `vscode-test` (unit tests plus integration tests driven by `vscode.env.clipboard`).

---

## Design

### Problem

The extension has no paste handling. VS Code's own auto-indent-on-paste only works for languages that ship indentation rules, and Clojure ships none, so pasted lines keep the absolute indentation they had at their source. Copying

```clojure
(def TEST
  {:a 1
   :b 2})
```

and pasting it at column 2 inside `(comment\n  |)` gives

```clojure
(comment
  (def TEST
  {:a 1
   :b 2}))
```

The maintain-relative-indentation listener (`src/maintainIndent.ts`) correctly does nothing here: it shifts the *tail* that followed the cursor, never the pasted body.

### Approach

Register a `DocumentPasteEditProvider` for Clojure. It returns the clipboard text with adjusted indentation and covers every paste entry point: `Ctrl+V`, the context menu, `Shift+Insert`, and *Paste As…*. This is the same mechanism VS Code's built-in auto-indent-on-paste and the TypeScript "paste with imports" feature use, so it composes with `editor.formatOnPaste` and with the undo stack the way users expect.

The indentation logic lives in a pure module, `src/pasteIndent.ts`, that imports nothing from `vscode` (the split `indent.ts`, `maintainIndent.ts` and `src/fmt/*` already follow). It takes the document text, the replaced selection, the clipboard text and an `indentAt` function, and returns the adjusted lines. The extension wiring maps that onto a `DocumentPasteEdit`.

### Algorithm (`planPaste`)

Mirrors VS Code's `AutoIndentOnPaste` (`editor/contrib/indentation`), with the engine's `indentAt` standing in for `getGoodIndentForLine`:

1. **Guards.** Split the clipboard on `\r\n`, `\r` or `\n`. Scan the document prefix up to the paste start with `Scanner`; inside a string or regex literal the paste is string content, return `null`. A single-line clipboard with nothing to adjust returns `null`.
2. **First line.** When the text before the paste on its line is spaces only (a tab anywhere in that prefix disables this step) and the clipboard's first line is not blank: the first line lands at `indentAt(text, start)`. Its own leading whitespace is dropped. If the target column is at or beyond the cursor column, the difference is prepended as spaces to the first line; if it is before the cursor column, `deleteBefore` reports how many prefix spaces the caller must remove immediately before the paste range. When the paste is mid-line (non-whitespace before the cursor) the first line is left exactly as copied.
3. **Body lines.** Build the post-paste text (prefix minus `deleteBefore`, adjusted lines joined with `\n`, suffix). Pick the *reference line*: the first pasted line after the first that is non-blank, not tab-indented, and does not start inside a string (`scanLineInfo` over the pasted line range). `delta = indentAt(postText, offsetOfReferenceLineStart) - referenceLineLeadingSpaces`. Shift every body line by `delta`, skipping blank lines, lines that start inside a string, and tab-indented lines; a negative shift clamps at column 0. No reference line means no body shift.
4. **No-op detection.** When `deleteBefore` is 0 and no line changed, return `null` so the caller returns no edit and VS Code's "paste as" hint widget stays hidden.

Relative structure inside the pasted block is preserved, including hand-aligned map values, because one uniform delta moves every line. This is Cursive's and IntelliJ's "indent block" behavior. A full reindent of every pasted line was rejected: with the cljfmt engine `formatRange` rewrites the whole enclosing top-level form and would touch code the user did not paste. Users who want that can enable `editor.formatOnPaste`, which already routes to the range formatter.

`indentAt` is called at most twice per paste (first line, reference line). The cljfmt probe costs about 30 ms worst case, so paste stays instant.

### Wiring

`setupPasteIndent(context)` in `src/extension.ts`, called from `activate` after `setupMaintainIndentation`:

- `vscode.languages.registerDocumentPasteEditProvider("clojure", provider, { providedPasteEditKinds: [PASTE_KIND], pasteMimeTypes: ["text/plain"] })` with `PASTE_KIND = vscode.DocumentDropOrPasteEditKind.Text.append("indent", "clojure")`.
- `provideDocumentPasteEdits` returns `undefined` when: more than one range (multi-cursor pastes stay plain), `context.only` is set and does not intersect `PASTE_KIND`, the data transfer has no `text/plain`, or `planPaste` returns `null`. It reads the clipboard with `(await dataTransfer.get("text/plain")?.asString())`, resolves the engine with `engineFor(doc)`, and calls `planPaste` with the range's offsets.
- The edit: `new vscode.DocumentPasteEdit(lines.join(eol), "Paste with Clojure indentation", PASTE_KIND)`, returned as a one-element array (`return [edit]`, the provider's return type is `DocumentPasteEdit[]`) where `eol` is `"\r\n"` for `vscode.EndOfLine.CRLF` documents and `"\n"` otherwise. When `deleteBefore > 0`, `additionalEdit` is a `WorkspaceEdit` deleting the `deleteBefore` characters immediately before `range.start` on the same line. The two edits are adjacent, never overlapping.
- The whole body is wrapped in `try … catch` returning `undefined`: a paste must never fail because of formatting.

The provider is always on. There is no setting: paste indentation is expected behavior for a Clojure editor, and VS Code's own `editor.pasteAs.enabled` already exists for users who want to switch off every paste provider. When the provider returns an edit, VS Code shows its small "paste as" hint after the paste, offering *Insert Plain Text* as the alternative. Because the provider returns nothing when the paste needs no change, the hint appears only when something was actually adjusted.

Interaction with the maintain-indentation listener: a plain paste raises one content change, so `planShift` still shifts any multi-line tail that followed the cursor, exactly as today. A paste that also carries the dedent `additionalEdit` raises a multi-change event and the listener skips it, as it does for every multi-part edit. That combination (dedenting paste on a whitespace-only line whose tail holds a multi-line form) is rare enough to accept.

### Engine requirement

`registerDocumentPasteEditProvider` and `DocumentDropOrPasteEditKind` were finalized in VS Code 1.97. `engines.vscode` moves from `^1.85.0` to `^1.97.0`, and the `@types/vscode` devDependency to `^1.97.0` to match (the installed types are already 1.125).

### Bug 1: Enter that reaches VS Code lands at the wrong column

The report's second symptom, a new line inside `[sentry-clj.metrics :as metrics]` landing one column right of the *first* vector on the line, is not produced by any indent computation in the extension or the server: `indentColumnAt`, the cljfmt probe, and clj-pulse's `handlers/indent.rs` all return the second vector's column for that input, and `planShift` returns no shift. Word wrap is off. The one thing that produces exactly that line is VS Code's own Enter: it copies the current line's indentation and keeps the space that preceded `metrics`, so the tail shows up at "first bracket plus one".

VS Code's Enter runs whenever the `clojurePulse.newline` keybinding is suppressed by its `when` clause (suggest widget visible, snippet mode, rename box, code-action menu). The suggest widget is the likely trigger here: keyword completions pop up after `:as`, and with `editor.acceptSuggestionOnEnter` set to `smart` or `off` Enter is not consumed by the widget and falls through to the plain newline. Snippet mode behaves the same way after any snippet insert.

**Fix: a fallback that reindents a plain newline after the fact.** A document-change listener (next to `maintainIndent`) watches for a single content change whose text is a newline followed only by spaces or tabs, in a Clojure document, not raised by the extension's own Enter command (a busy flag, as `maintainIndentBusy`). It computes the engine indent for the new line's start offset and, when the line's leading whitespace differs, replaces it in one edit merged into the keystroke's undo group (`undoStopBefore: false, undoStopAfter: false`) and moves the cursor to the new column if it sat inside the old whitespace. Only the first inserted line is touched (VS Code inserts two lines between an empty bracket pair; the closer line is left alone). A `null` indent (inside a string) means no edit.

This does not change the atomic Enter path: the keybinding still handles every ordinary Enter with no hop. The fallback only acts on newlines that bypassed it, where today the line is simply wrong. It is engine-aware, so cljfmt users get cljfmt columns in the fallback too, and it needs no VS Code setting (unlike re-enabling `editor.formatOnType`, which would also route through the server's structural-only rule with an LSP round trip).

Regression tests also pin the correct Enter column beside a sibling vector at unit and integration level.

### Testing

- **Unit** (`src/test/pasteIndent.test.ts`): `planPaste` with `structuralEngine.indentAt`, plus one case through `createCljfmtEngine` with defaults. Cases: the def-with-map example; paste at column 0 of a blank line inside a form (first line indents, body follows); paste on a whitespace-only line deeper than the target (dedent via `deleteBefore`); mid-line paste leaves the first line untouched; blank body lines untouched; multi-line string content untouched; tab-indented lines untouched; negative shift clamps at 0; single-line clipboard mid-line returns `null`; pasting over a non-empty selection (`start < end`) replaces it and indents the body relative to the selection start; paste inside a string returns `null`; already-correct paste returns `null`; CRLF clipboard splits correctly.
- **Integration** (`src/test/paste.integration.test.ts`): write to `vscode.env.clipboard`, run `editor.action.clipboardPasteAction`, and poll for the expected document text, following `newline.integration.test.ts`. Cases: the def-with-map example; a dedenting paste (exercises `additionalEdit`); a CRLF document keeps CRLF.
- **Bug 1**: `indent.test.ts` and `cljfmtEngine.test.ts` gain a two-vectors-on-one-line case; `newline.integration.test.ts` gains the same through the real Enter command, plus a `fallback newline` suite that types `\n` through VS Code's own `type` command and expects the engine column.

Run everything with `make test` (wraps `xvfb-run -a npm test` on Linux). Run one suite with `npm run compile-tests && xvfb-run -a npx vscode-test --grep "<suite name>"`.

---

## File Structure

- **Create `src/pasteIndent.ts`** — pure paste planner: `PasteContext`, `PastePlan`, `planPaste`. Depends only on `./indent` (`Scanner`, `scanLineInfo`).
- **Create `src/test/pasteIndent.test.ts`** — unit tests for `planPaste`.
- **Create `src/test/paste.integration.test.ts`** — end-to-end paste through the VS Code clipboard command.
- **Modify `src/extension.ts`** — `setupPasteIndent` (provider registration and `DocumentPasteEdit` mapping) and `setupNewlineFallback` (reindent a newline that bypassed the keybinding), both called from `activate`.
- **Modify `src/test/indent.test.ts`, `src/test/cljfmtEngine.test.ts`, `src/test/newline.integration.test.ts`** — bug 1 regression cases.
- **Modify `package.json`** — `engines.vscode` and `@types/vscode` to `^1.97.0`.
- **Modify `README.md`, `CHANGELOG.md`** — document indent on paste.

Shared shapes both tasks 1 and 3 must agree on:

```ts
export interface PasteContext {
  /** Full pre-paste document text. */
  text: string;
  /** Offsets of the replaced selection (`start === end` for a caret). */
  start: number;
  end: number;
  /** Clipboard text, any line endings. */
  clipboard: string;
}

export interface PastePlan {
  /** Adjusted clipboard lines; the caller joins them with the document EOL. */
  lines: string[];
  /** Spaces to delete immediately before `start` (0 = none). */
  deleteBefore: number;
}

export type IndentAt = (text: string, offset: number) => number | null;

/** `null` when the paste needs no adjustment. */
export function planPaste(ctx: PasteContext, indentAt: IndentAt): PastePlan | null;
```

---

## Tasks

### Task 1: Pure paste planner

**Files:**
- Create: `src/pasteIndent.ts`
- Test: `src/test/pasteIndent.test.ts`

- [ ] **Step 1: Write the failing tests**
  Create `src/test/pasteIndent.test.ts` (Mocha `suite`/`test`, `assert` from `node:assert`, like `maintainIndent.test.ts`). Use `structuralEngine.indentAt` from `../fmt/structuralEngine` as `indentAt`, and a helper `paste(text, marker, clipboard)` that finds a `|` marker in `text`, removes it, and calls `planPaste` with `start = end = markerOffset`. Cover every unit case listed under *Testing* in the design. Expected values for the headline case: text `"(comment\n  |)"`, clipboard `"(def TEST\n  {:a 1\n   :b 2})"` gives `lines = ["(def TEST", "    {:a 1", "     :b 2})"]`, `deleteBefore = 0`. Dedent case: text `"(comment\n      |)"` with the same clipboard gives `deleteBefore = 4` and the same lines. Column-0 case: text `"(comment\n|)"` gives `lines[0] = "  (def TEST"` and the same body. Add one cljfmt case using `createCljfmtEngine({ config: defaultConfig, maxInner: 2 }).indentAt` with the headline input, expecting the same output (cljfmt indents `def` bodies by 2).

- [ ] **Step 2: Run the tests to verify they fail**
  Run: `npm run compile-tests`
  Expected: compile error, `src/pasteIndent.ts` does not exist.

- [ ] **Step 3: Implement `planPaste`**
  Create `src/pasteIndent.ts` with the shared shapes above and the algorithm from the design. Notes: leading whitespace of a line is counted as spaces only; any tab in it marks the line tab-indented. Line offsets in the post-paste text are `start - deleteBefore + (sum of preceding adjusted line lengths) + (number of preceding newlines)`. Use `scanLineInfo(postText, firstPastedLine, lastPastedLine)` for `startsInString`, where `firstPastedLine` is the count of `\n` in `text.slice(0, start)`. Header comment in the style of `maintainIndent.ts`: what the module does, that it mirrors VS Code's auto-indent-on-paste with the engine as the oracle, and that every guard bails to "no change".

- [ ] **Step 4: Run the tests to verify they pass**
  Run: `npm run compile-tests && xvfb-run -a npx vscode-test --grep "planPaste"`
  Expected: all `planPaste` tests PASS.

- [ ] **Step 5: Lint and commit**
  Run: `npm run lint`
  `git commit -m "Add pure paste indentation planner"`

### Task 2: Engine requirement bump

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Bump versions**
  Set `engines.vscode` and the `@types/vscode` devDependency to `^1.97.0`. Run `npm install` so `package-lock.json` follows.

- [ ] **Step 2: Verify the build**
  Run: `npm run compile`
  Expected: clean.

- [ ] **Step 3: Commit**
  `git commit -m "Require VS Code 1.97 for the document paste API"`

### Task 3: Provider wiring

**Files:**
- Modify: `src/extension.ts`
- Test: `src/test/paste.integration.test.ts`

- [ ] **Step 1: Write the failing integration tests**
  Create `src/test/paste.integration.test.ts` following `newline.integration.test.ts` (same `openClojureDoc`, `cursor`, `waitForText` helpers and the `server.path` suite setup that keeps the language server out of the way). Each test writes the clipboard with `vscode.env.clipboard.writeText`, runs `vscode.commands.executeCommand("editor.action.clipboardPasteAction")`, and waits for the expected text. Cases: the headline example expecting `"(comment\n  (def TEST\n    {:a 1\n     :b 2}))"`; the dedent example `"(comment\n      )"` with the cursor at column 6 expecting the same result; a CRLF document (`editor.edit` + `setEndOfLine(vscode.EndOfLine.CRLF)` or `doc.eol` check) expecting `\r\n` throughout.

- [ ] **Step 2: Run the tests to verify they fail**
  Run: `npm run compile-tests && xvfb-run -a npx vscode-test --grep "paste"`
  Expected: FAIL, document text keeps the clipboard's original indentation.

- [ ] **Step 3: Implement `setupPasteIndent`**
  In `src/extension.ts`, add `setupPasteIndent(context)` per the *Wiring* section and call it from `activate` right after `setupMaintainIndentation(context)`. Place the function near `setupMaintainIndentation` with a doc comment explaining the provider, the always-on choice, and the hint-widget behavior.

- [ ] **Step 4: Run the tests to verify they pass**
  Run: `npm run compile-tests && xvfb-run -a npx vscode-test --grep "paste"`
  Expected: PASS.

- [ ] **Step 5: Run the full suite**
  Run: `make test`
  Expected: all tests PASS, lint clean.

- [ ] **Step 6: Commit**
  `git commit -m "Indent pasted Clojure forms with the formatting engine"`

### Task 4: Regression tests for Enter beside a sibling vector

**Files:**
- Modify: `src/test/indent.test.ts`
- Modify: `src/test/cljfmtEngine.test.ts`
- Modify: `src/test/newline.integration.test.ts`

- [ ] **Step 1: Add unit cases**
  `indent.test.ts`: `indentColumnAt("(:require [a :as b][c :as d])", offsetBefore("d"))` is 20 (column just after the second `[`). `cljfmtEngine.test.ts`: the same input through `indentAt` is 20.

- [ ] **Step 2: Add the integration case**
  `newline.integration.test.ts`: open `"(:require [a :as b][c :as d])"` with the cursor before `d`, run `clojurePulse.newline`, expect `"(:require [a :as b][c :as\n" + " ".repeat(20) + "d])"` and the cursor at `[1, 20]`.

- [ ] **Step 3: Run and commit**
  Run: `npm run compile-tests && xvfb-run -a npx vscode-test --grep "vector"`
  Expected: PASS.
  `git commit -m "Pin Enter indentation beside a sibling vector"`

### Task 5: Docs

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: README**
  Add an **Indent on paste** bullet after *Indent on Enter* in the features list: pasted multi-line forms are re-indented to the paste position with their internal layout preserved, the engine decides the column, and `editor.formatOnPaste` remains the way to get a full reformat. Mention that `editor.pasteAs.enabled` turns it off. Update the "requires VS Code" mention if the README states a version.

- [ ] **Step 2: CHANGELOG**
  Under `## [Unreleased]`, add an **Indent on paste** entry in the existing style, including the VS Code 1.97 requirement.

- [ ] **Step 3: Commit**
  `git commit -m "Document indent on paste"`

### Task 6: Fallback indent for a plain newline

**Files:**
- Modify: `src/extension.ts`
- Test: `src/test/newline.integration.test.ts`

- [ ] **Step 1: Write the failing integration tests**
  In `newline.integration.test.ts`, add a suite `fallback newline`: open `"(:require [a :as b][c :as d])"` with the cursor before `d`, run `vscode.commands.executeCommand("type", { text: "\n" })` (VS Code's own Enter path, which the keybinding never sees), and `waitForText` for `"(:require [a :as b][c :as\n" + " ".repeat(20) + "d])"`; also assert the cursor ends at `[1, 20]`. Add a string case: `'(def s "ab")'` with the cursor after `a`, type `"\n"`, expect `'(def s "a\nb")'` unchanged after a short wait (no reindent inside strings).

- [ ] **Step 2: Run the tests to verify they fail**
  Run: `npm run compile-tests && xvfb-run -a npx vscode-test --grep "fallback newline"`
  Expected: FAIL, the new line keeps VS Code's copied indentation.

- [ ] **Step 3: Implement the fallback listener**
  In `src/extension.ts`, add `setupNewlineFallback(context)` registering an `onDidChangeTextDocument` listener, called from `activate` next to `setupMaintainIndentation`. Bail unless: the document is Clojure, `event.reason` is undefined, there is exactly one content change, the change text matches `/^\r?\n[ \t]*(\r?\n[ \t]*)?$/`, and neither `newlineBusy` (set by `insertStructuralNewline` around its own edit) nor `maintainIndentBusy` is set. Compute `desired = engineFor(doc).indentAt(doc.getText(), doc.offsetAt(new Position(line, 0)))` for `line = change.range.start.line + 1`; on `null` or when the line's leading whitespace already equals `desired` spaces, return. Otherwise replace the leading whitespace with `undoStopBefore: false, undoStopAfter: false`, then, if the active cursor sits on that line at or before the old whitespace end, place it at `desired`. Guard the whole body with a `fallbackBusy` flag so the follow-up edit is not re-processed.

- [ ] **Step 4: Run the tests to verify they pass**
  Run: `npm run compile-tests && xvfb-run -a npx vscode-test --grep "newline"`
  Expected: PASS, including the existing `clojurePulse.newline` suite.

- [ ] **Step 5: Update docs and commit**
  README *Indent on Enter* bullet: the sentence "Enter falls through to VS Code whenever …" gains "and the new line is still reindented a moment later". CHANGELOG: a **Fixed** line under Unreleased.
  `git commit -m "Reindent a newline that bypassed the Enter keybinding"`
