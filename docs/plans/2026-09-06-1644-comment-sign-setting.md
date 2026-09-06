# Comment Sign Setting Implementation Plan

> **For agentic workers:** Use executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users pick `;;` instead of `;` as the token VS Code's Toggle Line Comment inserts in Clojure files.

**Tech Stack:** TypeScript, VS Code extension API (`vscode.languages.setLanguageConfiguration`), Mocha through `@vscode/test-cli`.

---

## Design

A new setting decides what VS Code's Toggle Line Comment and Add Line Comment
insert in Clojure files. Today the contributed `language-configuration.json`
fixes the token to `;`.

- **Setting:** `clojurePulse.lineComment`, `type: "string"`, `enum` of `";"`
  and `";;"`, `default: ";"`. The description says it sets the token
  Toggle Line Comment inserts, and that VS Code toggling is token-exact.
- **Mechanism:** `vscode.languages.setLanguageConfiguration("clojure",
  { comments: { lineComment } })`. VS Code merges this over the contributed
  `language-configuration.json` property by property, so brackets,
  auto-closing pairs, surrounding pairs, and the word pattern stay intact.
- **Register only when the value differs from the file default.** With `";"`
  nothing is registered, so `language-configuration.json` stays the single
  source of truth for the default. Choosing `";;"` registers the override.
  Changing the setting disposes the previous registration and applies the
  new one immediately, no window reload.
- **Token-exact toggling is accepted behavior.** With `";;"` chosen, a line
  that begins with a single `;` counts as uncommented, so toggling prepends
  `;; `. Calva ships `;;` and behaves the same way.

Structure: a new module `src/lineComment.ts` keeps the logic out of
`extension.ts` and testable without VS Code.

```ts
export type LineCommentToken = ";" | ";;";
export const DEFAULT_LINE_COMMENT: LineCommentToken = ";";

/** The setting's value, or the default for anything unexpected. */
export function lineCommentToken(raw: unknown): LineCommentToken;

/** Applies the current token, replacing any earlier registration.
 *  `register` is the seam over `setLanguageConfiguration`. */
export function createLineCommentApplier(
  register: (token: LineCommentToken) => { dispose(): void },
): { apply(token: LineCommentToken): void; dispose(): void };
```

`apply` disposes the previous registration (if any), then calls `register`
only when the token is not the default. Re-applying the same token disposes
and registers afresh: simple, and the configuration listener only fires on a
real change. `dispose` drops the current registration. `extension.ts` creates
the applier once in `activate`, applies the value read from
`clojurePulse.lineComment`, pushes the applier into `context.subscriptions`,
and re-applies from an `onDidChangeConfiguration` listener that checks
`affectsConfiguration("clojurePulse.lineComment")`.

Testing:

- Unit (`src/test/lineComment.test.ts`): `lineCommentToken` maps `";"`,
  `";;"`, and junk (`undefined`, `";;;"`, `42`) correctly. The applier
  registers nothing for the default, registers once for `";;"`, disposes the
  old registration whenever `apply` runs again, and `dispose` clears the
  active registration.
- Integration (`src/test/lineComment.integration.test.ts`): open an in-memory
  Clojure document, set the setting to `";;"` globally, run
  `editor.action.commentLine`, assert the line now starts with `;; `. Reset the
  setting to `undefined`, run the command on a fresh document, assert `; `.
  Restore the setting in `finally` as the other integration suites do. The
  runner uses a throwaway user-data directory, so no real setting is at risk.
- Manifest (`src/test/manifest.test.ts`): the setting is contributed with
  exactly those two enum values and the `";"` default.
- README: one row in the Configuration table.

---

## File Structure

- Create: `src/lineComment.ts` — token validation and the applier.
- Create: `src/test/lineComment.test.ts` — unit tests for the module.
- Create: `src/test/lineComment.integration.test.ts` — end-to-end comment toggling.
- Modify: `package.json` — contribute `clojurePulse.lineComment`.
- Modify: `src/test/manifest.test.ts` — pin the setting's shape.
- Modify: `src/extension.ts` — wire the applier in `activate`.
- Modify: `README.md` — Configuration table row.

Commands used throughout:

```bash
npm run compile-tests && npm run compile && npm run lint   # what `pretest` runs
npx vscode-test --label unit                                 # the whole unit label
```

`vscode-test` accepts `--grep`/`-g` to narrow a run, for example
`npx vscode-test --label unit -g "lineComment"`. Integration suites run under
the same `unit` label; nothing here needs the `jar-e2e` label.

---

### Task 1: Line comment module

**Files:**
- Create: `src/lineComment.ts`
- Test: `src/test/lineComment.test.ts`

- [x] **Step 1: Write the failing tests**
  Suite `lineComment`. Tests:
  - `the setting maps to a token, defaulting anything else to ";"`: covers
    `";"`, `";;"`, `undefined`, `";;;"`, `42`.
  - `the default token registers nothing`: a fake `register` that records
    tokens and returns a disposable counting disposes; `apply(";")` records
    nothing.
  - `a non-default token registers once`: `apply(";;")` records `[";;"]`.
  - `changing the token disposes the earlier registration`: `apply(";;")`,
    then `apply(";")` disposes the `;;` registration and registers nothing
    new; then `apply(";;")` registers again.
  - `dispose drops the active registration`: `apply(";;")`, `dispose()`,
    the registration's dispose count is 1.

- [x] **Step 2: Run the tests to verify they fail**
  Run: `npm run compile-tests && npx vscode-test --label unit -g "lineComment"`
  Expected: compile error on the missing module, or every test failing.

- [x] **Step 3: Implement the module**
  Export `LineCommentToken`, `DEFAULT_LINE_COMMENT`, `lineCommentToken`, and
  `createLineCommentApplier` with the signatures in the Design. Keep the
  applier a closure over one `current: { dispose(): void } | undefined`.
  Head the file with a short comment on why the default registers nothing
  (the language configuration file stays the source of truth).

- [x] **Step 4: Run the tests to verify they pass**
  Run: `npm run compile-tests && npx vscode-test --label unit -g "lineComment"`
  Expected: PASS.

- [x] **Step 5: Commit**
  `git commit -m "feat: line comment token applier"`

> Deviation: the test runner needs a display, so every `vscode-test` run here is
> prefixed with `xvfb-run -a`, as the Makefile and CI do.

### Task 2: Contribute the setting

**Files:**
- Modify: `package.json`
- Test: `src/test/manifest.test.ts`

- [x] **Step 1: Write the failing test**
  In the `manifest` suite add `the line comment setting offers ; and ;; with ; as default`.
  Read `contributes.configuration.properties["clojurePulse.lineComment"]`,
  assert `enum` deep-equals `[";", ";;"]` and `default` is `";"`.

- [x] **Step 2: Run the test to verify it fails**
  Run: `npm run compile-tests && npx vscode-test --label unit -g "line comment setting"`
  Expected: FAIL, property undefined.

- [x] **Step 3: Add the property**
  Place `clojurePulse.lineComment` after `clojurePulse.dimIgnoredFormsOpacity`.
  `type: "string"`, `enum: [";", ";;"]`, `default: ";"`, `enumDescriptions`
  for each, and a `markdownDescription` along the lines of: the token
  Toggle Line Comment (`Ctrl+/`) and Add Line Comment insert in Clojure files.
  Toggling is token-exact: with `;;` chosen, a line commented with a single
  `;` counts as code and gets `;;` in front. Applies immediately.

- [x] **Step 4: Run the test to verify it passes**
  Run: `npm run compile-tests && npx vscode-test --label unit -g "manifest"`
  Expected: PASS.

- [x] **Step 5: Commit**
  `git commit -m "feat: contribute the clojurePulse.lineComment setting"`

### Task 3: Wire the applier and prove it end to end

**Files:**
- Modify: `src/extension.ts`
- Test: `src/test/lineComment.integration.test.ts`

- [x] **Step 1: Write the failing integration test**
  Suite `line comment setting`. `suiteSetup` activates the extension the way
  `selectCurrentForm.integration.test.ts` does. `teardown` closes all editors.
  Helper `commentedFirstLine(setting)`: update `clojurePulse.lineComment` to
  `setting` at `ConfigurationTarget.Global`, open an in-memory `clojure`
  document containing `(foo)\n` with the cursor on line 0, run
  `editor.action.commentLine`, return line 0's text. Tests:
  - `";;" makes Toggle Line Comment insert ;;`: expect `;; (foo)`.
  - `the default inserts a single ;`: setting `undefined`, expect `; (foo)`.
  Run the `;;` case first and reset the setting to `undefined` in `finally`
  so a failure cannot leak into other suites. A short wait (about 100 ms)
  after the settings update lets the configuration-change listener land
  before the command runs.

- [x] **Step 2: Run the test to verify it fails**
  Run: `npm run compile-tests && npm run compile && npx vscode-test --label unit -g "line comment setting"`
  Expected: the `;;` case fails with `; (foo)`; the default case passes.

- [x] **Step 3: Wire it in `activate`**
  In `src/extension.ts` import the module and, near the other configuration-
  driven setup at the top of `activate`, create the applier with
  `register: (token) => vscode.languages.setLanguageConfiguration("clojure", { comments: { lineComment: token } })`.
  Read the setting with `getConfiguration("clojurePulse").get("lineComment")`
  through `lineCommentToken`, apply it, and push into `context.subscriptions`
  both the applier and an `onDidChangeConfiguration` listener that re-reads
  and re-applies when `affectsConfiguration("clojurePulse.lineComment")`.

- [x] **Step 4: Run the test to verify it passes**
  Run: `npm run compile-tests && npm run compile && npx vscode-test --label unit -g "line comment setting"`
  Expected: PASS for both cases.

- [x] **Step 5: Run the whole unit label**
  Run: `npm test`
  Expected: PASS. If the indent or paste integration suites regress, the
  override merged more than `comments`; check the registered object carries
  only that key.

- [x] **Step 6: Commit**
  `git commit -m "feat: choose ; or ;; for Toggle Line Comment"`

### Task 4: Document the setting

**Files:**
- Modify: `README.md`

- [x] **Step 1: Add the Configuration row**
  After the `clojurePulse.test.reloadBeforeRun` row add
  `clojurePulse.lineComment` with default `";"` and a one-sentence
  description: the token Toggle Line Comment inserts, `";"` or `";;"`.
  Follow /writing-clearly.

- [x] **Step 2: Commit**
  `git commit -m "docs: describe the clojurePulse.lineComment setting"`

---

## Completed

**Status: done.** All four tasks landed on `comment-sign-setting`:

- `59bfb8e` — `src/lineComment.ts` (token validation, applier over a `register`
  seam) with five unit tests.
- `d6ead7a` — `clojurePulse.lineComment` contributed in `package.json`, pinned
  by a new `manifest` test.
- `9e636ae` — wired in `activate`: the applier, the initial apply, and an
  `onDidChangeConfiguration` re-apply, all in `context.subscriptions`. Proven
  by `src/test/lineComment.integration.test.ts`, which sets the setting and
  runs `editor.action.commentLine` in a real editor.
- `d993b0c` — README Configuration row.

Final verification: `npm test` — 854 passing, 0 failing. The `;;` case of the
integration suite is the end-to-end pass: setting changed at runtime, real
Toggle Line Comment, `;; (foo)` in the buffer, no window reload. Each task got
a `codex exec review` checkpoint; the only finding was on Task 2 ("the setting
does nothing yet"), which Task 3 was already about to fix. No other issues, no
fixup commits.

Deviations: only the `xvfb-run -a` prefix noted under Task 1 — an environment
detail, not a design change.

**What the plan could have specified better:** the test commands. Every
`vscode-test` invocation needs a display, so the plan's bare
`npx vscode-test --label unit` fails outright on a headless machine; the repo's
own Makefile and CI already prefix it with `xvfb-run -a`, and the plan should
have copied that. Everything else held up exactly as written, including the
predicted failure output at each red step.
