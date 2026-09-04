# Head-Position Keyword Highlighting Implementation Plan

**Status: completed** (2026-09-04).

> **For agentic workers:** Use executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A local named `defenders` (or `use`, `cond`, `when-ready`) stops being highlighted as a definition or control keyword — the bundled TextMate grammar recognises those words only in head position.

**Tech Stack:** TextMate grammar JSON (`syntaxes/clojure.tmLanguage.json`), Mocha via `vscode-test`, `vscode-textmate` + `vscode-oniguruma` as devDependencies for real tokenization in tests.

---

## Design

### Problem

`(let [defenders (find-defenders)] ...)` paints `defenders` with the same scope
as `defn`. The cause is the `keyfn` rule in the bundled grammar, whose lookbehind
accepts any delimiter rather than an opening paren
(`syntaxes/clojure.tmLanguage.json:136`):

```
(?<=(\s|\(|\[|\{))(declare-?|(in-)?ns|import|use|require|load|compile|(def[\p{Ll}\-]*))(?=(\s|\)|\]|\}))
```

`def[\p{Ll}\-]*` matches `defenders`, and the `[` of the let vector satisfies the
lookbehind, so the symbol gets `keyword.control.clojure`. The same happens in
argument position — `(pick defenders team)` — where a space satisfies it.

The sibling pattern one line above (`syntaxes/clojure.tmLanguage.json:131`) has
the identical flaw for the control forms: in `(let [when-ready 1 cond 2])` both
`when-ready` and `cond` come out as `storage.control.clojure`.

### Approach

A symbol is a macro or special-form invocation only in **head position**. Change
the lookbehind of both `keyfn` patterns from `(?<=(\s|\(|\[|\{))` to `(?<=\()`.
That is the entire fix — two character classes narrowed, no new rules, no
whitelist.

Head position still matches everywhere it should: `(`, `#(`, `'(` and `` `( ``
all put `(` immediately before the symbol, which is all the lookbehind inspects.

Definition forms keep their highlighting through a different rule. The `sexp`
rule's `meta.definition.global` pattern (`syntaxes/clojure.tmLanguage.json:303`)
already does its own `(?<=\()` capture, scoping the `def*` head as
`keyword.control.clojure` and the defined name as `entity.global.clojure`. So
`(defn foo ...)` is untouched by this change.

What the change gives up is highlighting for these words quoted as data —
`'[if when]`, `[def]` — which is the correct outcome: there they are symbols,
not invocations.

It also gives up two unidiomatic spellings: `( when x)`, with whitespace after
the paren, and a head symbol sitting on the line after its `(`. The lookbehind
inspects only the character immediately before the symbol, and Oniguruma rejects
an unbounded `(?<=\(\s*)`, so tolerating separators would mean restructuring
`keyfn` into a capture-based `begin` rule. The newline case is beyond a
single-line pattern whatever we do, and cljfmt removes both spellings, so the
restructuring is not worth its cost.

Both `keyfn` patterns are fixed, not just the `def*` one. It is the same root
cause and the same edit, and it removes the whole class of false positives at
once.

### Not in scope

`(defenders x)` — a *call* to a function named `defenders` — still scopes `x` as
`entity.global.clojure`, because `meta.definition.global` fires on any
paren-headed `def*` symbol. TextMate cannot tell a user-defined macro
(`defroutes`, `defstate`, `deftest` — all common) from a function that happens to
start with `def`, and a whitelist would break far more than it fixes. Task 4
records this in the backlog.

### Testing

Grammar changes are verified by tokenizing with the real engine, not by matching
the regexes by hand: rule precedence — which of `keyfn`, `meta.definition.global`
and `symbol` claims a token — is where grammar bugs live, and only a full
tokenizer run reflects it.

`src/test/grammar.test.ts` loads `syntaxes/clojure.tmLanguage.json` into a
`vscode-textmate` `Registry` backed by `vscode-oniguruma`, tokenizes a snippet
line by line carrying the rule stack, and exposes one helper:

```ts
function scopesAt(source: string, line: number, column: number): string[]
```

returning the scope stack of the token covering that position. Assertions are
then `assert.ok(scopes.includes("..."))` / `!scopes.includes("...")`.

Both devDependencies are test-only. `esbuild` bundles `src/extension.ts`, which
never imports them, so the `.vsix` is unaffected.

### Attribution

`syntaxes/NOTICE` currently states the grammar was converted from
atom/language-clojure "without changes to the patterns". Once the patterns
change, that sentence is wrong; the MIT notice stays, and a line records the
local modification.

## File Structure

- `syntaxes/clojure.tmLanguage.json` — modify: the two `keyfn` lookbehinds.
- `src/test/grammar.test.ts` — create: tokenization harness plus scope assertions.
- `package.json` — modify: add `vscode-textmate` and `vscode-oniguruma` devDependencies.
- `syntaxes/NOTICE` — modify: record the local pattern change.
- `CHANGELOG.md` — modify: an `Unreleased` entry.
- `docs/backlog/def-prefixed-call-highlighted-as-definition.md` — create: the
  remaining `(defenders x)` case.

---

### Task 1: Grammar test harness and the failing cases

**Files:**
- Modify: `package.json`
- Create: `src/test/grammar.test.ts`

- [x] **Step 1: Add the test-only dependencies**
  `npm install --save-dev vscode-textmate vscode-oniguruma`
  Both land in `devDependencies`; check `package-lock.json` is updated too.

- [x] **Step 2: Write the tokenization harness**
  In `src/test/grammar.test.ts`, a `suiteSetup` builds the registry once:
  read `onig.wasm` from `node_modules/vscode-oniguruma/release/onig.wasm` and
  pass the `Buffer` straight to `oniguruma.loadWASM` (it accepts an
  `ArrayBufferView`; do not use `.buffer`, which is pooled). Then

  ```ts
  const registry = new vsctm.Registry({
    onigLib: Promise.resolve({
      createOnigScanner: (s: string[]) => new oniguruma.OnigScanner(s),
      createOnigString: (s: string) => new oniguruma.OnigString(s),
    }),
    loadGrammar: async () =>
      vsctm.parseRawGrammar(fs.readFileSync(grammarPath, "utf8"), grammarPath),
  });
  const grammar = await registry.loadGrammar("source.clojure");
  ```

  Tests compile to `out/test/`, so the repo root is
  `path.join(__dirname, "..", "..")` — resolve both the wasm and
  `syntaxes/clojure.tmLanguage.json` from there.
  `scopesAt(source, line, column)` splits `source` on `\n`, calls
  `grammar.tokenizeLine` for each line while carrying the returned `ruleStack`,
  and returns the `scopes` of the token on `line` whose
  `startIndex <= column < endIndex`.

- [x] **Step 3: Write the failing assertions**
  A `suite("clojure grammar")` with the cases below. The first four fail today;
  the rest are regression guards that must pass before and after.

  - `(let [defenders 1]\n  defenders)` — the binding `defenders` is not
    `keyword.control.clojure`, and is `meta.symbol.clojure`.
  - `(let [when-ready 1 cond 2])` — neither `when-ready` nor `cond` is
    `storage.control.clojure`.
  - `(pick defenders team)` — the argument `defenders` is not
    `keyword.control.clojure`.
  - `'[if when]` and `[def]` — quoted or bracketed as data, these carry
    neither control scope and are `meta.symbol.clojure`.
  - `(defn foo [x] x)` — `defn` is `keyword.control.clojure`, `foo` is
    `entity.global.clojure`.
  - `(def x 1)` and `(ns foo.bar)` — the head is `keyword.control.clojure`.
  - `(when x 1)` and `#(when % 1)` — `when` is `storage.control.clojure`
    (the second confirms `#(` still counts as head position).

- [x] **Step 4: Run the suite to verify the new cases fail**
  Run: `make test`
  Expected: FAIL — the three new-behaviour cases report `defenders` /
  `when-ready` / `cond` carrying `keyword.control.clojure` or
  `storage.control.clojure`; every regression guard passes.

- [x] **Step 5: Commit**
  `git commit -m "test: tokenize the Clojure grammar in tests"`

> Deviation: the test file adds a thin `scopesOf(source, line, symbol)` wrapper
> over `scopesAt` so each case names the symbol it reads instead of computing a
> column. Same helper, readable call sites.

---

### Task 2: Restrict the keyword patterns to head position

**Files:**
- Modify: `syntaxes/clojure.tmLanguage.json`
- Modify: `syntaxes/NOTICE`

- [x] **Step 1: Narrow both lookbehinds**
  In the `keyfn` rule, replace the leading `(?<=(\\s|\\(|\\[|\\{))` with
  `(?<=\\()` in both patterns — the `storage.control.clojure` one
  (`syntaxes/clojure.tmLanguage.json:131`) and the `keyword.control.clojure` one
  (`syntaxes/clojure.tmLanguage.json:136`). Leave the alternation and the
  trailing lookahead exactly as they are; this is a two-line diff.

- [x] **Step 2: Run the suite to verify it passes**
  Run: `make test`
  Expected: PASS — all grammar cases green, and the rest of the suite unchanged.

- [x] **Step 3: Record the modification in the NOTICE**
  `syntaxes/NOTICE` says the grammar was converted "without changes to the
  patterns". Replace that with a statement that it was converted from CSON to
  JSON and since modified locally, naming this change: the `keyfn` patterns now
  require head position. Keep both licences intact.

- [x] **Step 4: Commit**
  `git commit -m "fix: highlight def and control forms only in head position"`

---

### Task 3: Changelog

**Files:**
- Modify: `CHANGELOG.md`

- [x] **Step 1: Add the entry**
  Under `## [Unreleased]`, a `- **Fixed**:` bullet in the voice of the existing
  entries: a local whose name starts with `def` — `defenders` — or matches a
  control form (`when-ready`, `cond`, `use`) was highlighted as if it were the
  `defn` in a definition. These words are now highlighted only where they are
  actually invoked, at the head of a form; `defn`, `def`, custom `def*` macros
  and every special form are unaffected. Use /writing-clearly.

- [x] **Step 2: Commit**
  `git commit -m "docs: changelog entry for head-position highlighting"`

---

### Task 4: Backlog the remaining case

**Files:**
- Create: `docs/backlog/def-prefixed-call-highlighted-as-definition.md`

- [x] **Step 1: Write the backlog file**
  Follow `AGENTS.md` and the shape of
  `docs/backlog/format-selection-column-offset.md`: a title, `**Status: open**`,
  then the problem. Calling a *function* whose name starts with `def` —
  `(defenders team)` — matches `meta.definition.global`
  (`syntaxes/clojure.tmLanguage.json:303`), so the head is painted as a keyword
  and the first argument as `entity.global.clojure`. Note why it is left alone:
  a TextMate grammar cannot distinguish it from a user-defined `def*` macro, and
  a whitelist of known def forms would break `defroutes`, `defstate`, `deftest`
  and the rest. Note that a fix would need semantic tokens from the language
  server, and that functions named `def*` are rare.

- [x] **Step 2: Commit**
  `git commit -m "docs: backlog def-prefixed calls read as definitions"`

---

### Task 5: Verify

- [x] **Step 1: Full check**
  Run: `make check`
  Expected: lint, type-check and the whole suite pass.

- [x] **Step 2: Confirm in the editor**
  `make install-extension`, reload VS Code, open a Clojure file containing
  `(let [defenders 1] defenders)` next to a `(defn foo [] 1)`. `defenders` reads
  as a plain symbol in both positions; `defn` and `foo` are unchanged. Check a
  `(when ...)`, a `#(when ...)` and an `(ns ...)` form still highlight.

> Deviation: no GUI was available, so this ran as a differential tokenization
> instead — a realistic namespace (ns/require, `def`, `defn-`, `defmulti`,
> `defmethod`, let, `when`, `case`, `cond`, try/catch/throw, `#(...)`, quoted
> data) tokenized through the real TextMate engine under the old and the new
> grammar, comparing every token's scopes. Exactly 11 of 169 tokens changed,
> all of them intended: the locals `defenders`, `when-ready` and `use`, and the
> quoted `'[if when def defn]`. Every keyword in head position kept its scope.

---

## Completion Summary

The `keyfn` rule's two lookbehinds now require head position, so a local named
`defenders` — or `use`, `cond`, `when-ready` — is scoped `meta.symbol.clojure`
instead of `keyword.control.clojure` / `storage.control.clojure`. Definition and
control forms are unaffected, because `(defn foo ...)` gets its keyword from the
`sexp` rule's `meta.definition.global` pattern, which already required head
position.

`src/test/grammar.test.ts` now tokenizes the shipped grammar with
`vscode-textmate` + `vscode-oniguruma` (test-only dependencies) and asserts
scopes for seven cases: the three bug reports, quoted data, and three regression
guards. All four new-behaviour cases failed before the grammar change and pass
after. `make check` is green: 793 passing, 1 pending, 0 failing.

`syntaxes/NOTICE` records the local modification to the upstream
atom/language-clojure patterns, `CHANGELOG.md` has an `Unreleased` entry, and
`docs/backlog/def-prefixed-call-highlighted-as-definition.md` records the one
case left open — calling a *function* named `def*` still reads as a definition,
which needs semantic tokens from `clj-pulse` rather than a grammar change.

Codex reviewed each code task. On the test commit it objected to the red state
of a TDD commit, which is what the plan asked for and what the next commit
resolves; on the grammar commit it found nothing.

**Deviations:** two, both noted above — a `scopesOf` wrapper in the test file,
and tokenizer-level rather than GUI verification.

**What the plan could have specified better:** the end-to-end step assumed a GUI
that was not available. A plan for a grammar change should name the differential
tokenization as the verification, with the editor check as a nicety — it is the
stronger check anyway, since it compares every token rather than the few a human
notices.
