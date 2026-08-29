# Current Form Highlight and Select Implementation Plan

> **For agentic workers:** Use executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Highlight the bracket pair of the form that *Evaluate Current Form* would evaluate — replacing VS Code's native bracket matching in Clojure files — and add a *Select Current Form* command that selects that same form.

**Tech Stack:** TypeScript, VS Code extension API (`TextEditorDecorationType`, `ThemeColor`, `configurationDefaults`), Mocha via `vscode-test`.

---

## Design

### Problem

`formAtCursor` (`src/repl/forms.ts`) decides what *Evaluate Current Form* sends. VS Code's native bracket matcher (`editor.matchBrackets`, default `"near"`) decides which pair is highlighted. They disagree in three common places:

- Sandwich `(foo)|(bar)` — native highlights `(bar)`; eval picks `(foo)` (rule 3 beats rule 4, by design).
- Before a closer `(println "hi"|)` — native highlights the enclosing parens; eval picks `"hi"`.
- Whitespace inside a list `(foo | bar)` — native shows nothing; eval picks the enclosing list.

So the highlight lies about what a keypress will do. The fix is to let the editor show what eval will pick.

### Approach

1. A pure `bracketPairAtCursor(text, offset)` beside `formAtCursor`, sharing the same walk, returns the offsets of the opening and closing bracket of the resolved form (null for atoms, strings, and unbalanced code).
2. A decorator (`src/formHighlight.ts`) paints those two characters in every visible Clojure editor, for every cursor, using the native bracket-match theme colors — so it is visually identical to VS Code's own highlight.
3. `package.json` sets `editor.matchBrackets: "never"` as the `[clojure]` default. The decorator draws **only** when the effective Clojure-scoped value is `"never"`, so the one setting is the one knob: set it back to `"near"` and stock VS Code returns, with no double highlight possible.
4. A `clojurePulse.selectCurrentForm` command selects the `formAtCursor` range — a preview of what eval will send, and a stepping stone to structural selection later.

### Decisions (settled in discussion)

- **Single knob.** No `clojurePulse.*` setting for the highlight; `editor.matchBrackets` in the `[clojure]` scope controls it. Precedence assumption: an extension's language-scoped default beats a user's global setting. An extension test pins this.
- **Pair, not form.** Decorate only the two bracket characters. A whole-form background would compete with the eval flash and inline results. Atoms and strings get nothing.
- **Unbalanced code = no highlight.** `formAtCursor` returns null when the reader hits an unclosed form before the cursor. Native would still match individual pairs; we accept the regression for v1 and document it.
- **Full parity with eval**, including rule 6: cursor in top-level whitespace highlights the previous top-level form's pair, even when off-screen.
- **No debounce.** `formAtCursor` is one linear scan; measure before optimizing.
- **Out of scope:** a `SelectionRangeProvider` / expand-selection behavior. Separate follow-up.

### Components

**`src/repl/forms.ts`** — reader and resolution rules (existing).
- `resolveIn` returns the resolved `ReadForm` instead of a stripped `FormRange`.
- `formAtCursor` keeps its signature and output: `stripped(form)`.
- New export:
  ```ts
  /** Offsets of the opening and closing bracket of the form at the cursor. */
  export interface BracketPair { open: number; close: number; }
  export function bracketPairAtCursor(text: string, offset: number): BracketPair | null;
  ```
  Null when the resolved form's base is not bracketed (`bracketOffset === null`) or nothing resolves. Reader prefixes and `#_` markers do not affect the result — the pair is always the base form's brackets.

**`src/formHighlight.ts`** — the decorator (new), modeled on `src/ignoredForms.ts`.
- `createFormHighlighter(): FormHighlighter` with `{ refresh(editor), refreshAll(), dispose() }`.
- One `TextEditorDecorationType`:
  `backgroundColor: ThemeColor("editorBracketMatch.background")`,
  `borderColor: ThemeColor("editorBracketMatch.border")`,
  `borderStyle: "solid"`, `borderWidth: "1px"`, `rangeBehavior: ClosedClosed`,
  with `boxSizing: border-box` folded into the border via `textDecoration: "none; box-sizing: border-box"` — matches the native `.bracket-match` CSS.
- `refresh(editor)`: if `editor.document.languageId !== "clojure"` or the highlight is disabled, set an empty decoration list and return. Otherwise, for every `selection` in `editor.selections`, compute `bracketPairAtCursor(text, offsetAt(selection.active))` and collect two one-character ranges per non-null pair. Set them all at once.
- `enabled(document)`:
  `vscode.workspace.getConfiguration("editor", { languageId: "clojure", uri: document.uri }).get<string>("matchBrackets") === "never"`.
- `refreshAll()`: `refresh` every `vscode.window.visibleTextEditors`.

**`src/extension.ts`** — wiring in `activate`.
- Create the highlighter; push to `context.subscriptions`.
- Subscriptions: `onDidChangeTextEditorSelection(e => refresh(e.textEditor))`; `onDidChangeTextDocument(e => visible editors of e.document → refresh)`; `onDidChangeActiveTextEditor(editor => editor && refresh(editor))`; `onDidChangeVisibleTextEditors(() => refreshAll())`; `onDidChangeConfiguration(e => e.affectsConfiguration("editor.matchBrackets") && refreshAll())`. Then `refreshAll()` once at activation.
- Register `clojurePulse.selectCurrentForm` next to `evalCurrentForm`:
  resolve `formAtCursor(text, offsetAt(selection.active))`; on null, `setStatusBarMessage("Clojure Pulse: no form found at cursor", 3000)` and return; otherwise `editor.selection = new Selection(start, end)` — anchor at the form start, active at the half-open `end` offset, so the caret sits immediately after the closing bracket — then `editor.revealRange(editor.selection)`. An existing non-empty selection is ignored; the form is resolved from `selection.active`.

**`package.json`**
- `configurationDefaults["[clojure]"]["editor.matchBrackets"] = "never"`.
- New command `clojurePulse.selectCurrentForm`, title *Select Current Form*, category *Clojure Pulse*. No default keybinding (consistent with the eval commands).

### Error handling

The decorator must never throw from an event handler: a null pair, a non-Clojure document, or a disabled setting all resolve to "set no decorations". The command reports "no form" through the status bar exactly like `evalCurrentForm`.

### Testing

- **Unit (`src/test/forms.test.ts`)** — `bracketPairAtCursor` per rule, with a `pair(source)` helper returning the two bracket characters' offsets relative to a `|`-marked source: after a closer (rule 3), before an opener (rule 4), sandwich prefers the preceding form, inside a token → null, before a closer `(foo|)` → the token's pair is null but `(foo |)` → the list, whitespace inside a list (rule 5), nested innermost, top-level whitespace (rule 6), nothing before → null, prefixed forms (`'(…)`, `#_(…)`, `^:m [...]`, `#{…}`, `#(…)`) → the base's brackets, string → null, unbalanced → null. The existing `formAtCursor` suite must pass unchanged (guards the refactor).
- **Integration (`src/test/selectCurrentForm.integration.test.ts`)** — open an in-memory `clojure` document, place the cursor, run the command, assert `editor.selection`: after a closer selects the whole form with `anchor` at its start and `active` at its end; in whitespace inside a list selects the enclosing list; in a `#_` form selects without the marker; unbalanced text leaves the selection unchanged.
- **Integration (`src/test/formHighlight.integration.test.ts`)** — the Clojure-scoped `editor.matchBrackets` resolves to `"never"` in the test host while the unscoped value stays `"near"`: this pins the precedence assumption. Decorations are not observable through the API, so the decorator's rendering is covered by the pure function plus the manual check in Task 6.

### Running tests here

`npm test` launches a VS Code test host, which needs a display. CI uses `xvfb-run -a npm test`; do the same on a headless machine (no `DISPLAY`), including for the filtered runs below: `xvfb-run -a npm test -- --grep "<pattern>"`. `pretest` (compile-tests, compile, lint) runs before every invocation, so a type error surfaces as a compile failure rather than a test failure.

## File Structure

- Modify: `src/repl/forms.ts` — `resolveIn` returns `ReadForm`; add `BracketPair`, `bracketPairAtCursor`.
- Create: `src/formHighlight.ts` — decoration type, `enabled`, `refresh`, `refreshAll`, `dispose`.
- Modify: `src/extension.ts` — highlighter wiring; `selectCurrentForm` command.
- Modify: `package.json` — `[clojure]` default; command contribution.
- Modify: `src/test/forms.test.ts` — `bracketPairAtCursor` suite.
- Create: `src/test/selectCurrentForm.integration.test.ts`.
- Create: `src/test/formHighlight.integration.test.ts`.
- Modify: `README.md`, `CHANGELOG.md`.

---

### Task 1: `bracketPairAtCursor` in the reader

**Files:**
- Modify: `src/repl/forms.ts`
- Test: `src/test/forms.test.ts`

- [ ] **Step 1: Write the failing tests**
  Add a `pair(source)` helper next to `form(source)` that returns `{ open: text[open], close: text[close], openOffset, closeOffset }` or null. Add a `suite("bracketPairAtCursor", …)` covering: `"(+ 1 2)|"` → `(`/`)` at 0 and 6; `"|(+ 1 2)"` → same; `"(foo)|(bar)"` → the `(foo)` pair; `"(+ fo|o 2)"` → null; `"(foo|)"` → null (the token `foo` wins); `"(foo |)"` → the list; `"(a (b |c) d)"` → the `(b c)` pair; `"(a b)\n\n|"` → the `(a b)` pair; `"|"` → null; `"'(a b)|"`, `"#_(a b)|"`, `"^:m [a b]|"`, `"#{a b}|"`, `"#(inc %)|"` → the base's brackets; `'"str"|'` → null; `"(unclosed |"` → null; `"[a] (unclosed\n|"` → null.

- [ ] **Step 2: Run the suite to see it fail**
  Run: `npm test -- --grep bracketPairAtCursor` (`pretest` compiles; the compile fails on the missing export, which is the expected failure).
  Expected: compile error `Module '"../repl/forms"' has no exported member 'bracketPairAtCursor'`.

- [ ] **Step 3: Implement**
  Change `resolveIn` to return `ReadForm | null` (return `prev` / the resolved `form` un-stripped; the `enclosing` parameter becomes a `ReadForm | null`). Add a private `readFormAtCursor(text, offset)` that clamps and calls `resolveIn`; `formAtCursor` becomes `stripped(readFormAtCursor(...))` when non-null. Add `bracketPairAtCursor` returning `{ open: form.bracketOffset, close: form.closerOffset }` when `bracketOffset !== null`. Update the header comment to mention the new export.

- [ ] **Step 4: Run the whole forms suite**
  Run: `npm test -- --grep "formAtCursor|bracketPairAtCursor|testAtCursor|testsInText|nsBefore"`
  Expected: PASS, with no change to the existing `formAtCursor` cases.

- [ ] **Step 5: Commit**
  `git commit -am "Add bracketPairAtCursor sharing the eval form resolution"`

### Task 2: `[clojure]` default and the precedence test

**Files:**
- Modify: `package.json`
- Create: `src/test/formHighlight.integration.test.ts`

- [ ] **Step 1: Write the failing test**
  One suite: activate the extension (as `extension.test.ts` does), then assert `vscode.workspace.getConfiguration("editor", { languageId: "clojure" }).get("matchBrackets") === "never"` and `vscode.workspace.getConfiguration("editor").get("matchBrackets") === "near"`.

- [ ] **Step 2: Run it to see it fail**
  Run: `npm test -- --grep "matchBrackets"`
  Expected: FAIL — the Clojure-scoped value is `"near"`.

- [ ] **Step 3: Add the default**
  In `package.json` `contributes.configurationDefaults["[clojure]"]`, add `"editor.matchBrackets": "never"` beside `editor.formatOnType`.

- [ ] **Step 4: Run it to see it pass**
  Run: `npm test -- --grep "matchBrackets"`
  Expected: PASS. If it fails, the precedence assumption is wrong — stop and report before continuing; the guard in Task 3 depends on it.

- [ ] **Step 5: Commit**
  `git add package.json src/test/formHighlight.integration.test.ts && git commit -m "Turn off native bracket matching for Clojure files"`

### Task 3: The form highlighter

**Files:**
- Create: `src/formHighlight.ts`
- Modify: `src/extension.ts`

- [ ] **Step 1: Implement `createFormHighlighter`**
  Follow the shape of `createIgnoredFormDecorator` in `src/ignoredForms.ts`: a factory returning `{ refresh, refreshAll, dispose }`. The decoration type and `enabled` check are as described in the design. `refresh` collects, for each selection, the two one-character `Range`s of the pair at `selection.active`, and calls `editor.setDecorations` once (an empty array when disabled, not Clojure, or nothing resolves). Add a file header comment explaining the single-knob rule and why the highlight follows `formAtCursor`.

- [ ] **Step 2: Wire it in `activate`**
  Create the highlighter after the inline results manager, push it and the five event subscriptions from the design to `context.subscriptions`, then call `refreshAll()` once. Keep the handlers one-liners that delegate to the highlighter.

- [ ] **Step 3: Compile and lint**
  Run: `npm run compile && npm run lint`
  Expected: no errors.

- [ ] **Step 4: Commit**
  `git add src/formHighlight.ts src/extension.ts && git commit -m "Highlight the bracket pair of the form eval would pick"`

### Task 4: Select Current Form

**Files:**
- Modify: `package.json`
- Modify: `src/extension.ts`
- Create: `src/test/selectCurrentForm.integration.test.ts`

- [ ] **Step 1: Write the failing tests**
  Helper: `open(source)` splits on `|`, calls `vscode.workspace.openTextDocument({ language: "clojure", content })`, shows it, sets `editor.selection` to the cursor position, and returns the editor. Cases: `"(defn f [x] (inc x))|"` selects the whole form, `anchor` at 0 and `active` at the end; `"(a (b |c) d)"` selects `(b c)`; `"#_(a b)|"` selects `(a b)`; `"(unclosed |"` leaves the selection empty and at the cursor. Register `clojurePulse.selectCurrentForm` in the `registers its commands` list style by asserting it is in `getCommands(true)`.

- [ ] **Step 2: Run to see it fail**
  Run: `npm test -- --grep "selectCurrentForm"`
  Expected: FAIL — `command 'clojurePulse.selectCurrentForm' not found`.

- [ ] **Step 3: Implement**
  Add the command to `package.json` (`"title": "Select Current Form"`, `"category": "Clojure Pulse"`). In `extension.ts`, add `selectCurrentForm()` beside `evalCurrentForm` and register it in the same block. Behavior per the design: resolve from `selection.active`, status-bar message on null, else set the selection and reveal it.

- [ ] **Step 4: Run to see it pass**
  Run: `npm test -- --grep "selectCurrentForm"`
  Expected: PASS.

- [ ] **Step 5: Commit**
  `git add package.json src/extension.ts src/test/selectCurrentForm.integration.test.ts && git commit -m "Add Select Current Form command"`

### Task 5: Docs

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: README**
  Use /writing-clearly. In *Features*, extend the syntax-highlighting bullet or add one: bracket highlighting follows the form *Evaluate Current Form* would pick. In *Evaluating* (after the *Evaluate Current Form* bullet), one short paragraph: the highlighted pair is the form eval will send; it replaces VS Code's matcher in Clojure files via the `[clojure]` default of `editor.matchBrackets: "never"`; set it to `"near"` in your own `[clojure]` settings to get the native matcher back; with an unclosed bracket earlier in the file nothing is highlighted below it. Add **Clojure Pulse: Select Current Form** to the *Commands* list after *Evaluate Current Form*, noting that eval on a selection sends exactly what is selected. In *Configuration*, if there is a list of editor defaults the extension sets, add `editor.matchBrackets` there.

- [ ] **Step 2: CHANGELOG**
  Two entries under *Unreleased*, in the existing bold-lead style: **Bracket highlighting shows the form eval will pick** (what changed, the one-setting escape hatch, the unbalanced-code caveat) and **Select Current Form** (what it selects, that it pairs with eval).

- [ ] **Step 3: Commit**
  `git commit -am "Document form highlighting and Select Current Form"`

### Task 6: Full verification

**Files:** none new.

- [ ] **Step 1: Full automated suite**
  Run: `npm test`
  Expected: `pretest` (compile-tests, compile, lint) clean; every suite passes, including the untouched `formAtCursor`, `testAtCursor`, `nsBefore` cases and both new integration files.

- [ ] **Step 2: Production build**
  Run: `npm run package-build`
  Expected: `tsc --noEmit` clean and esbuild produces `dist/extension.js` without warnings.

- [ ] **Step 3: Behavior check in the Extension Development Host**
  Open the repo in VS Code, press F5, open a `.clj` file (or an untitled Clojure buffer) and confirm each, comparing against a non-Clojure file where native matching still works:
  - `(foo)|(bar)` highlights `(foo)`; `(println "hi"|)` highlights nothing; `(foo | bar)` highlights the enclosing parens; cursor two blank lines below a top-level form highlights that form's pair.
  - Two cursors (Alt+Click) each get their own pair.
  - Typing inside a form keeps the highlight on the right pair; an unclosed `(` above the cursor clears it, closing it restores it.
  - Split the editor: both panes highlight.
  - Add `"[clojure]": { "editor.matchBrackets": "near" }` to user settings: ours disappears and the native highlight returns without reload; set it back to `"never"`: ours returns.
  - Run **Clojure Pulse: Select Current Form** after a closer, then **Evaluate Current Form** with a REPL connected: the evaluated range equals the selection.
  - Colors match the native highlight in both a light and a dark theme.
  Record anything that deviates in the hand-off report rather than fixing silently.

- [ ] **Step 4: Rough performance check**
  Open the largest `.clj` file at hand (or paste `clojure.core` from a `jar:` source into a scratch buffer — around 8k lines) and hold an arrow key: cursor movement must stay smooth. If it stutters, note it as a follow-up (restart the reader at the enclosing top-level form) rather than adding a debounce here.
