# Language Features Inside JAR Sources Implementation Plan

> **For agentic workers:** Use executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Go to definition, hover, completion and the rest of clj-pulse's language features work inside a dependency's source opened from a `jar:` URI, not only in the project's own files.

**Tech Stack:** TypeScript VS Code extension, `vscode-languageclient/node`, clj-pulse 0.2.0 over stdio; mocha (tdd ui) via `@vscode/test-cli`.

---

## Design

### The problem

Open a dependency's source — jump into `integrant.repl`, or browse a jar in the
External Libraries panel — and nothing works there. No go to definition, no
hover, not even on `defn`. The file reads like plain text.

`src/client.ts:33` is the whole reason:

```ts
documentSelector: [{ scheme: "file", language: LANGUAGE_ID }],
```

VS Code only routes LSP requests for documents matching the selector. A file
opened from a jar has the `jar:` scheme, so no request is ever sent. The
`jar:` content provider registered in `src/extension.ts:188` supplies the
document's *text* through `clojure/dependencyContents`, and that is all it
does — it was never the piece that would have made language features work.

### The fix

Add `{ scheme: "jar", language: LANGUAGE_ID }` to the selector. Nothing else
in the client changes: `vscode-languageclient` then sends `didOpen` for a jar
document like any other and forwards definition, hover, completion, references
and document symbols to the server.

### Why this is enough — verified, not assumed

clj-pulse 0.2.0 was driven directly over stdio against a real project
(`~/Projects/readx`), with a jar document opened through `didOpen`:

- `initialize` advertises `experimental.textDocumentContentProvider.schemes:
  ["jar"]` — the server already declares it serves jar URIs.
- `textDocument/definition` inside `clj_reload/core.clj`: `defn` resolves to
  `clojure/core.clj` in the Clojure jar, `util/throwable?` to
  `clj_reload/util.clj` in the same jar.
- `textDocument/hover` inside the same document returns the full docstring for
  `defn` and the arglists for `util/throwable?`.
- `publishDiagnostics` arrived **only** for the `file:` document, never for a
  `jar:` one. Read-only dependency sources therefore stay free of squiggles,
  which was the one real risk of widening the selector.

### Decisions

- **No server capability gating.** The selector is fixed when the client is
  constructed, before `initialize`, so it cannot react to the advertised
  capability. It does not need to: a server that cannot resolve a jar URI
  returns nothing, which is exactly today's behavior. Any server that serves
  jar *content* already understands jar URIs, and the extension has always
  required one that does.
- **The selector becomes an exported constant.** `src/client.ts` has no tests,
  and `LanguageClient` does not expose its options, so the selector is
  untestable where it sits. `CLOJURE_DOCUMENT_SELECTOR` gives a cheap
  regression guard, following how the repo isolates testable pieces
  (`testReload.ts`, `replConfig.ts`).
- **`jar` only.** `untitled` buffers are a separate question with a different
  answer and are out of scope.

### Known limit

With the server active in jar documents, its `renameProvider` and
`codeActionProvider` become reachable there. A jar document is read-only, so
edits cannot apply and an attempted rename inside a dependency fails. This
matches how clojure-lsp behaves in other editors; it is documented, not
engineered around.

### Testing strategy

Two levels, because they prove different things:

- **Unit** (`src/test/client.test.ts`): `CLOJURE_DOCUMENT_SELECTOR` carries
  both schemes for the `clojure` language. This only stops the selector
  regressing; it proves nothing about the feature.
- **End to end** (`src/test/lspJar.e2e.test.ts`): the only test that proves the
  feature. It needs a real clj-pulse and a real classpath, so it is opt-in
  behind `CLJ_PULSE_E2E_BIN` and skips when unset — the same bargain
  `src/test/clojureDocs.e2e.test.ts` already makes, which keeps the default
  suite hermetic.

The e2e test navigates from a temp deps.edn project into `clojure.core` (always
on any Clojure classpath, so it needs no third-party dependency), then asserts
that definition and hover work *inside* the jar document it landed in.

## File Structure

- Modify `src/client.ts` — export `CLOJURE_DOCUMENT_SELECTOR`, add the `jar`
  entry, and say in the doc comment why the scheme is there.
- Create `src/test/client.test.ts` — unit test for the constant.
- Create `src/test/lspJar.e2e.test.ts` — opt-in end-to-end test.
- Modify `README.md` — the "Library navigation" bullet. This is the only
  user-facing doc: `CHANGELOG.md` was removed from the repo in `d5ccfbe`, so
  do not add or recreate it.

## Tasks

### Task 1: Route jar documents to the server

**Files:**
- Modify: `src/client.ts`
- Test: `src/test/client.test.ts`

- [x] **Step 1: Write the failing test**
  Create `src/test/client.test.ts` (mocha tdd, like `src/test/serverPath.test.ts`).
  Import `CLOJURE_DOCUMENT_SELECTOR` from `../client` and assert it holds an
  entry for each of the `file` and `jar` schemes, both with language
  `clojure`. Add one sentence in the test naming what breaks without the `jar`
  entry: VS Code sends no LSP request at all for a dependency's source, so
  nothing resolves there.

- [x] **Step 2: Run the test to verify it fails**
  Run: `npm run compile-tests`
  Expected: FAIL — `client.ts` has no export named `CLOJURE_DOCUMENT_SELECTOR`.

- [x] **Step 3: Implement**
  In `src/client.ts`, lift the selector out of `clientOptions` into an exported
  `CLOJURE_DOCUMENT_SELECTOR` and add the jar entry:

  ```ts
  export const CLOJURE_DOCUMENT_SELECTOR = [
    { scheme: "file", language: LANGUAGE_ID },
    { scheme: "jar", language: LANGUAGE_ID },
  ];
  ```

  Give it a doc comment explaining the `jar` half: a dependency's source opens
  through the `jar:` content provider registered in `extension.ts`, and without
  a matching selector entry VS Code routes no request for it, so the file reads
  as plain text. Reference it from `clientOptions`.

- [x] **Step 4: Run the test to verify it passes**
  Run: `npm run compile-tests && npm run compile && xvfb-run -a npx vscode-test --grep "document selector"`
  Expected: PASS.

- [x] **Step 5: Run the whole suite**
  Run: `npm run lint && xvfb-run -a npm test`
  Expected: PASS, no regressions.

- [x] **Step 6: Commit**
  `git commit -m "Route jar documents to the language server"`

### Task 2: End-to-end proof against a real server

**Files:**
- Create: `src/test/lspJar.e2e.test.ts`

- [x] **Step 1: Write the test**
  Model the file header, `suiteSetup`, `suiteTeardown` and the `CLJ_PULSE_E2E_BIN`
  skip on `src/test/clojureDocs.e2e.test.ts` — same `server.path` override,
  same `clojurePulse.restart` to pick it up, same cleanup. Suite name: something
  containing "jar end to end" so it can be grepped on its own.

  One test, generously timed (the server resolves a classpath on first index;
  allow at least 120s):
  - Write a temp project: a directory with `deps.edn` containing
    `{:paths ["src"]}` and `src/demo.clj` with an `(ns demo)` form and a call to
    a `clojure.core` var, e.g. `(map inc [1 2 3])`.
  - Open `src/demo.clj`, wait for the server to index it (poll for a definition
    result rather than sleeping a fixed time; `clojureDocs.e2e.test.ts` shows
    the shape).
  - `vscode.executeDefinitionProvider` on the `map` symbol → expect a location
    whose URI scheme is `jar`. This is the "from a file: document" leg that
    already worked; assert it to get the jar URI.
  - `vscode.workspace.openTextDocument` on that jar URI, which the content
    provider fills in.
  - **The actual assertion:** `vscode.executeDefinitionProvider` and
    `vscode.executeHoverProvider` at a symbol *inside* that jar document both
    return a non-empty result.

    Choose the position syntactically, not by plain-text search: a bare search
    for a name can land inside a docstring or comment, where nothing resolves
    and the test would fail for the wrong reason. Find the first line matching
    `/^\(defn /` and target the `defn` symbol itself (character 1-4 of that
    line). `defn` in a head position resolves to `clojure/core.clj` and hovers
    with its docstring — confirmed against clj-pulse 0.2.0 during design — and
    it survives any Clojure release moving code around, which a hard-coded line
    number would not.

- [x] **Step 2: Run it with a real server**
  Run: `CLJ_PULSE_E2E_BIN=$(command -v clj-pulse || echo ~/.local/share/mise/installs/github-abogoyavlensky-clj-pulse/0.2.0/clj-pulse) xvfb-run -a npx vscode-test --grep "jar end to end"`
  Expected: PASS. If the binary resolves to a mise shim and the run fails with
  a mise trust error, use the absolute install path instead — the shim refuses
  to run inside an untrusted project directory.

- [x] **Step 3: Confirm it skips without the binary**
  Run: `xvfb-run -a npx vscode-test --grep "jar end to end"`
  Expected: the test is pending/skipped, not failing.

- [x] **Step 4: Run the whole suite**
  Run: `npm run lint && xvfb-run -a npm test`
  Expected: PASS.

- [x] **Step 5: Commit**
  `git commit -m "Prove language features work inside a jar source end to end"`

### Task 3: Docs

**Files:**
- Modify: `README.md`

- [x] **Step 1: README**
  Use /writing-clearly.
  In the **Library navigation** bullet (around line 36), say that a `jar:`
  source opens read-only *and keeps its language features* — go to definition,
  hover and completion work inside a dependency the same as in your own code.
  Add the limit in the same breath: the file is read-only, so refactorings that
  would edit it (rename) cannot apply there.

  There is no CHANGELOG step: the file was removed from the repo in `d5ccfbe`.
  Do not recreate it.

- [x] **Step 2: Commit**
  `git commit -m "Document language features in jar sources"`

---

## Completion

**Status: done.** All three tasks landed on `fix-lsp-navigation-in-jar`:
`9fd51c8` (selector), `f8c57d2` (end-to-end test), `f0c512e` (README), plus a
follow-up fixing review nits.

What shipped: `CLOJURE_DOCUMENT_SELECTOR` in `src/client.ts` now carries the
`jar` scheme alongside `file`, a unit test guards it, an opt-in end-to-end test
proves the feature against a real server, and the README's Library navigation
bullet says language features come with a `jar:` source and that rename cannot
apply there.

### Verification

Re-verified against **clj-pulse 0.3.0 built from the local checkout**, not the
0.2.0 the plan was designed against. Driving the server directly over stdio
with a real project: `textDocument/definition` on `map` returns
`jar:…/clojure-1.12.5.jar!/clojure/core.clj`; definition and hover *inside*
that jar document both answer (`defn` → line 293 of `clojure/core.clj`, hover
returns its arglists); `publishDiagnostics` arrives only for the `file:` URI,
so read-only sources stay free of squiggles on 0.3.0 too.

The end-to-end test was checked to actually test the feature: with the `jar`
selector entry removed it fails (`no definition for \`defn\` inside
jar:…/clojure/core.clj at line 339`) and with it restored it passes. Full
suite: 821 passing, 1 pending (the e2e test skipping itself in the `unit`
config), both test configurations green.

### Deviations

> Deviation (Task 2): the e2e test uses a checked-in fixture project
> (`src/test/fixtures/jar-project`) opened as a workspace folder by a second
> `.vscode-test.mjs` configuration (`jar-e2e`), not a temp directory. clj-pulse
> indexes the folders the client sends in `initialize` and resolves their
> classpath from there; the test run opens no workspace folder, so with a temp
> project the server had no classpath and no jar to navigate into. The test
> skips itself when no workspace folder is present, which is how it stays
> pending in the `unit` configuration.

> Deviation (Task 2): the fixture accumulates `.cpcache/` and `.clj-pulse/`
> when the server resolves its classpath at test time; both are gitignored.

> Deviation (all tasks): the codex review checkpoint could not run — the local
> Codex CLI is broken (`Missing optional dependency @openai/codex-linux-x64`).
> The inline `code-review` skill was run against the branch instead. It found
> no must-fix items; its two nits were investigated and neither was
> actionable — `as const` on the selector does not type-check against
> `DocumentSelector`, and `@vscode/test-cli` cannot exclude a file from a
> configuration's `files` (globs are unioned, `ignore` comes only from the
> CLI). The `.vscode-test.mjs` comment now records the latter.

### What the plan could have specified better

The plan's e2e design missed that clj-pulse needs a workspace folder to resolve
a classpath at all, and that the VS Code test harness opens none by default —
so "write a temp project and open a file from it" could not work as written.
A plan that pins a test against a real server should state where the server's
project root comes from in that harness, not just what the test asserts.
