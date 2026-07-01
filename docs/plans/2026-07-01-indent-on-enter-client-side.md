# Indent-on-Enter (Option B-client) — extension owns the Enter key

> **For agentic workers:** Use executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make indent-on-Enter **jump-free and instant** by binding Enter to a Clojure Pulse command that inserts the newline *and* the correct indentation in one atomic edit, with the indent computed client-side. This is the escape hatch if Option A's `onTypeFormatting` cursor "settle" is too visible.

**Tech Stack:** TypeScript (VS Code extension), a small hand-written Clojure scanner. No new runtime deps.

**Prerequisite / relationship to Plan A:** Do this *only after* Plan A (`clj-pulse/docs/plans/2026-07-01-ontype-indentation-tier-a.md`) is merged, and *only if* the onTypeFormatting hop is unacceptable. This plan **reuses A partially**:
- clj-pulse's server-side indenter (from A) **stays** — it serves other editors (nvim/zed/emacs) and backs future explicit "reindent" / range-formatting.
- The **indent rule is identical**; here it is mirrored in TypeScript for the VS Code hot path (the Calva-style "client-side hot path, authoritative server" split).
- A's `editor.formatOnType` default is **flipped off** for Clojure, so the server's onTypeFormatting no longer drives Enter in VS Code (the keybinding does, atomically). clj-pulse keeps advertising the capability for other clients.

---

## Design

### Why client-side

`onTypeFormatting` runs *after* the newline is inserted, so the cursor lands at the editor's guessed column and then hops to ours — visible, worst in alignment cases, and amplified by the LSP round-trip. Owning Enter lets us insert `\n` + the exact spaces as **one edit**, so the cursor never lands wrong: no hop, no round-trip, instant.

### The rule (identical to Plan A)

`indent = (column just after the open delimiter) + offset`, `offset = 1` iff the delimiter is `(`/`#(` and the first form is a symbol:
- `[] {} #{}` and non-symbol-headed `(` → align to first element.
- `(` / `#()` with a symbol head → 2-space.
- inside a string/regex → don't indent (fall back to a plain newline at column 0 / previous indent).
- top level → 0.

### Key decisions

- **Client-side scanner, not a parser dependency.** Compute the indent with a small forward tokenizer over the text *up to the cursor* that maintains a stack of open brackets, skipping Clojure lexical constructs (`;` line comments, `"…"` strings with `\"`, `#"…"` regexes, `\c` char literals; treat `#_` as transparent for bracket balance). The stack top at the cursor is the innermost open bracket → apply the rule. This mirrors Clojure Sublimed's `cs_parser`/`cs_indent`. Prefix-only ⇒ robust to unbalanced code and Parinfer-managed closers (same rationale as Plan A).
- **Atomic, multi-cursor-safe edit.** The `clojurePulse.newline` command replaces each selection with `"\n" + " ".repeat(indent)` in a single `editor.edit`, then places each cursor after the inserted indent.
- **Gate with a `when` clause, fall through otherwise.** Bind Enter only in a plain editing context; when it does not match, VS Code's default Enter runs — so autocomplete-accept, snippets, rename box, and panels are untouched (no manual handling needed).
- **Flip `formatOnType` off for Clojure** so the two mechanisms don't both fire. clj-pulse's onTypeFormatting stays available for other editors.
- **Pure, testable core:** `indentColumnAt(text: string, offset: number): number | null` (`null` = plain newline, e.g. inside a string). Mirror Plan A's unit cases so both implementations agree.

### Components & structure

```
clojure-pulse-vscode/
├─ src/indent.ts        NEW — indentColumnAt() scanner + rule (pure)
├─ src/extension.ts     MODIFY — register clojurePulse.newline command
├─ package.json         MODIFY — command + keybinding contributions; flip [clojure] formatOnType to false
└─ src/test/indent.test.ts   NEW — unit tests mirroring clj-pulse's cases
```

### Testing

- **Unit** (`indent.test.ts`): the same matrix as Plan A's `indent_at` — `(let [a 1`, `(when x`, vectors/maps/sets/`#{}`/`#()`, non-symbol head, nested, inside-string (→ `null`), top level (→ 0); plus comment/char/regex skipping edge cases.
- **Integration** (Extension Host): execute `clojurePulse.newline` at a position and assert the buffer/cursor; assert multi-cursor works.
- Run headless via `xvfb-run -a npm test` (existing harness).

## Tasks

### Task 1: Client-side indent core (TDD)

**Files:**
- Create: `src/indent.ts`, `src/test/indent.test.ts`

- [ ] **Step 1: Write failing unit tests**
  `indentColumnAt(text, offset)` returns the target column (or `null`). Mirror Plan A's cases exactly, expressing each as `text` + cursor `offset` (byte/char index into `text`). Include skipping cases: an open bracket inside a `;` comment or a `"string"` before the cursor must **not** be counted.

- [ ] **Step 2: Run tests to verify they fail**
  Run: `npm test`
  Expected: FAIL — `src/indent.ts` missing.

- [ ] **Step 3: Implement the scanner**
  Forward single pass over `text.slice(0, offset)` maintaining a stack; each stack frame records the open delimiter's column and whether a symbol has been seen as the first inner form. Skip `;`→EOL, `"…"`/`#"…"` (honor `\"`), `\<char>` literals; treat `#_` as transparent. Push on `(` `[` `{` `#{` `#(`, pop on `)` `]` `}`. At the end, if the innermost open frame is a string context → `null`; else compute `column-after-delimiter + offset` per the rule. Use UTF-16 code-unit columns (VS Code `Position.character`).

- [ ] **Step 4: Run tests to verify they pass**
  Run: `npm test`
  Expected: PASS.

- [ ] **Step 5: Lint + commit**
  Run: `npm run lint`
  `git commit -m "feat: client-side structural indent computation"`

### Task 2: Own the Enter key

**Files:**
- Modify: `src/extension.ts`, `package.json`

- [ ] **Step 1: Register the command**
  Add `clojurePulse.newline`: for each selection, compute `indentColumnAt(doc.getText(), offsetAt(sel.active))`; build the replacement `"\n" + " ".repeat(col ?? 0)`; apply all in one `editor.edit`; set cursors after the inserted indent. Push the registration in `activate`.

- [ ] **Step 2: Contribute command + keybinding**
  In `package.json`: add the command to `contributes.commands`; add a `contributes.keybindings` entry binding `enter` to `clojurePulse.newline` with `when`: `editorTextFocus && !editorReadonly && editorLangId == clojure && !suggestWidgetVisible && !renameInputVisible && !inSnippetMode`.

- [ ] **Step 3: Flip formatOnType off**
  In `contributes.configurationDefaults` `"[clojure]"`, set `"editor.formatOnType": false` (overriding Plan A's default; leave a comment noting clj-pulse still advertises onTypeFormatting for other editors).

- [ ] **Step 4: Compile + manual check**
  Run: `npm run compile`, then F5: press Enter inside `(let [a 1|])` (aligns under `a`, **no visible hop**), inside `(when x|)` (2-space), and with the suggest widget open (default accept still works). Test a multi-cursor Enter.

- [ ] **Step 5: Commit**
  `git commit -m "feat: own Enter for jump-free indent-on-newline"`

### Task 3: Integration tests + docs

**Files:**
- Modify: `src/test/` (new integration test), `README.md`

- [ ] **Step 1: Integration test**
  In the Extension Host: open an untitled `clojure` doc, set text `(let [a 1])` with the cursor before `]`, run `vscode.commands.executeCommand("clojurePulse.newline")`, assert the document is `(let [a 1\n      ])` and the cursor is at column 6; add a multi-cursor case.

- [ ] **Step 2: Run tests**
  Run: `xvfb-run -a npm test`
  Expected: PASS.

- [ ] **Step 3: Docs**
  In `README.md`, note that indent-on-Enter is handled client-side for a jump-free feel, and the Parinfer guidance (Indent Mode complementary; Paren/Smart mode — the keybinding still owns Enter, so remove/override the `clojurePulse.newline` keybinding if you prefer Parinfer to drive).

- [ ] **Step 4: Commit**
  `git commit -m "test+docs: client-side indent-on-Enter"`
