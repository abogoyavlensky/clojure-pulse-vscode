# Offline ClojureDocs Implementation Plan

**Status: completed** (2026-09-02). Summary at the end.

> **For agentic workers:** Use executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the ClojureDocs entry (docstring, arglists, examples, see-alsos) for the symbol under the cursor on a keyboard shortcut, with no network call at runtime: the extension bundles the data, the clj-pulse server resolves the symbol and serves it.

**Tech Stack:** TypeScript VS Code extension (`vscode-languageclient` 9, esbuild, mocha via `@vscode/test-cli`, `node --test` for scripts); Rust LSP server clj-pulse (tower-lsp, serde_json, existing `resolve_symbol`); GitHub Actions.

**Repos:** this extension at `/home/agent/Projects/clojure-pulse-vscode` and the server at `/home/agent/Projects/clj-pulse`. Server tasks come first because the extension depends on the protocol. Both repos get a `feature/clojuredocs` branch.

---

## Design

### Approach

The extension ships `data/clojuredocs.json`, a stripped copy of the official ClojureDocs export, refreshed monthly by a scheduled workflow. On server start the extension passes the file's absolute path in `initializationOptions`. The server loads the file on first use, resolves the word under the cursor with its existing namespace- and alias-aware resolver, and answers a custom request. The extension renders the answer in a webview panel beside the editor. The extension never parses the data and never resolves symbols.

Why this split: the server already knows aliases, refers, and the current namespace (`src/handlers/mod.rs` `resolve_symbol`); reimplementing that in the extension would be worse. Bundling avoids any network dependency and any prompt. The data is about 1.2 MB on disk and about 0.5 MB compressed inside the vsix.

### Licensing (settled)

ClojureDocs shows under every example submission form: "Examples submitted to ClojureDocs are licensed under the Creative Commons CC0 license." Docstrings and arglists are EPL 1.0 from Clojure. See-also relations are bare facts. **Notes carry no stated license and are excluded** from the bundled file and from the protocol. The panel footer credits ClojureDocs with a link to the var's page and names CC0; the README names the data source and licenses.

### Protocol (the contract both repos implement)

Request method: `clojurePulse/clojureDocs`.

```jsonc
// params, one of:
{ "textDocument": { "uri": "file:///…/core.clj" }, "position": { "line": 3, "character": 4 } }
{ "symbol": "clojure.core/pmap" }   // direct lookup, used by see-also clicks

// result:
{ "symbol": "clojure.core/map", "entry": { …Entry… } }   // found
{ "symbol": "clojure.core/frob", "entry": null }          // resolved, no ClojureDocs entry
{ "symbol": null, "entry": null }                          // nothing under the cursor

// Entry:
{
  "ns": "clojure.core",
  "name": "map",
  "doc": "Returns a lazy sequence…",      // optional
  "arglists": ["[f]", "[f coll]"],        // may be empty; the server wraps the export's bare "f coll" in brackets
  "added": "1.0",                         // optional
  "examples": ["(map inc [1 2 3])\n;;=> (2 3 4)"],
  "seeAlsos": ["clojure.core/mapv", "clojure.core/pmap"],
  "url": "https://clojuredocs.org/clojure.core/map"
}
```

Errors: a JSON-RPC error (tower-lsp `jsonrpc::Error` with a message) when no data path was configured or the file failed to load. An older server answers method-not-found (`-32601`); the extension maps that to "needs clj-pulse 0.4.0 or newer".

### Data file

`data/clojuredocs.json` keeps the **official export's shape** with fewer fields, so any editor can point the server at the raw download instead:

```jsonc
{ "description": "ClojureDocs Data Export",
  "vars": [
    { "ns": "clojure.core", "name": "map", "doc": "…", "arglists": ["f", "f coll"],
      "added": "1.0", "href": "/clojure.core/map",
      "examples": [ { "body": "(map inc [1 2 3])" } ],
      "see-alsos": [ { "to-var": { "ns": "clojure.core", "name": "mapv" } } ] }
  ] }
```

Dropped: `created-at` (changes on every export, would defeat change detection), `notes`, authors, avatars, ids, timestamps, `type`, `file`, `column`, `library-url`. Vars are sorted by `ns` then `name`; the file is written one var per line so review diffs show exactly which vars changed. `href` is kept verbatim because ClojureDocs munges names in URLs (`ends-with?` becomes `ends-with_q`); the server falls back to `/{ns}/{name}` when `href` is absent.

The build script accepts a URL or a local path, so tests and offline runs never hit the network. The script and its test live in `scripts/` and run under Node's built-in test runner, because the mocha suite runs inside the VS Code host and cannot import an `.mjs` script cleanly.

### Server side (clj-pulse)

- `src/clojuredocs.rs`: the data model (serde structs mirroring the export, every field `#[serde(default)]`, unknown fields ignored), `parse`, `load(path)`, lookup by fqn `"ns/name"`, and `path_from_init_options`.
- `src/handlers/clojuredocs.rs`: `resolve_var(index, word, current_ns) -> Option<String>` returning the fqn to look up, and the response type. Resolution order: `resolve_symbol` first. A project symbol yields its `fqn` (this covers `str/join` once the Clojure jar is indexed). `Core` and `LetgoNative` yield `clojure.core/<name>`. `SpecialForm` yields `clojure.core/<sf.name>` because ClojureDocs documents `if`, `do`, `let`, and friends there. When `resolve_symbol` finds nothing: a word containing `/` is split at the first `/`, the left part expanded through the current namespace's `aliases` map (falling back to the literal), giving `<ns>/<name>`; a bare word yields `clojure.core/<word>`. This fallback makes clojure.string, clojure.set, and similar work before any jar is indexed. A leading `'` or `#'` on the word is stripped first.
- `Backend` gains a `clojuredocs` field: a mutex-guarded state `{ path: Option<PathBuf>, loaded: Option<Arc<ClojureDocs>>, failed: bool }`. `initialize` stores the path from `initializationOptions.clojuredocs.path`. The request handler loads lazily on first call; a load failure is logged once at warn level and reported as a request error every time, so the editor can show it.
- Registered in `src/main.rs` next to the other `clojurePulse/*` custom methods. Init option only; no CLI flag. Every LSP client can set init options, and a flag is a small addition later if one cannot.
- Not touched: hover. Appending an "N examples" line to hover is a possible follow-up, not part of this plan.

### Extension side

- `src/clojureDocs.ts`: pure module, no `vscode` import. Types for the result, `renderClojureDocsHtml(result, nonce)`, `describeClojureDocsFailure(error, serverVersion)`, `noEntryMessage(symbol)`. Constant `CLOJUREDOCS_MIN_SERVER = "0.4.0"`.
- `src/clojureDocsPanel.ts`: `ClojureDocsPanel`, the `projectFormPanel.ts` pattern. Injected `createPanel` and `lookup`. One panel, reused; opened in `ViewColumn.Beside` with `preserveFocus: true` so the cursor stays in the editor. See-also links post `{ type: "lookup", symbol }` back to the host, which re-requests by symbol and re-renders in place, so a user can surf see-alsos without leaving the panel.
- `src/extension.ts`: command `clojurePulse.showClojureDocs`. Word range from `document.getWordRangeAtPosition`, which uses the Clojure `wordPattern` from `language-configuration.json`. Sends `{textDocument, position}`. `entry: null` shows an information message naming the resolved symbol and leaves the panel alone. A request error goes through `describeClojureDocsFailure` and is shown as a warning. The init options gain `clojuredocs: { path }` where path is `context.asAbsolutePath("data/clojuredocs.json")`.
- `package.json`: the command, and a default keybinding `ctrl+alt+d` limited to `editorTextFocus && editorLangId == clojure`. This is a documentation lookup like hover, so unlike the eval commands it ships with a default. `ctrl+alt+d` is unbound in VS Code and avoids the macOS Dock toggle on `cmd+alt+d`.
- `.github/workflows/clojuredocs-update.yml`: monthly cron plus `workflow_dispatch`; runs the build script; opens a pull request only when `data/clojuredocs.json` changed. Requires the repository setting "Allow GitHub Actions to create and approve pull requests".

### Rendering

Sections in order, each omitted when empty: header `ns/name` with the arglists in a code block; "Available since {added}"; the docstring in a `<pre>` that wraps; "Examples" numbered, each in a `<pre><code>`; "See also" as links; footer "Examples from ClojureDocs, CC0. Docstring from Clojure, EPL." with the page link. Text is HTML-escaped; the CSP allows only the nonce'd style and script, as in `projectFormPanel.ts`. Styling uses VS Code theme variables; the code font is `--vscode-editor-font-family`.

### Error handling

| Situation | Behaviour |
|---|---|
| Server not running | Information message: "clj-pulse is not running." |
| Cursor not on a word | Information message: "Place the cursor on a symbol." |
| Server too old (`-32601`) | Warning: "Show ClojureDocs needs clj-pulse 0.4.0 or newer (running X)." |
| Data not configured or unreadable | Warning with the server's error message |
| Resolved but no entry | Information message: "No ClojureDocs entry for clojure.core/frob." |

### Testing

- Server: unit tests in `src/clojuredocs.rs` and `src/handlers/clojuredocs.rs` (fixture-backed `Index`, as `tests/test_hover.rs` builds it); e2e tests in `tests/test_e2e.rs` through the real binary with a hand-written fixture export, covering a bare `map`, an aliased `str/join`, a direct `symbol` lookup, and the not-configured error. `bb check` and `bb e2e` must pass.
- Extension: `node --test` for the strip script; mocha unit tests for the renderer, failure mapping, and the panel with a fake host. `make check` must pass. A manual smoke run at the end against a locally built server.

### Versions

The extension gates on server `0.4.0`. Cargo.toml is at `0.3.0`; per `docs/RELEASE.md` the bump happens at release time, not in this branch. The server release that ships this feature must be `0.4.0`.

## File Structure

**clj-pulse (server)**
- Create `src/clojuredocs.rs` — export data model, parse/load, lookup, init-option path extraction. Unit tests inline.
- Create `src/handlers/clojuredocs.rs` — `resolve_var`, `DocsResult` response type, fqn → entry lookup. Unit tests inline.
- Modify `src/handlers/mod.rs` — `pub mod clojuredocs;`.
- Modify `src/lib.rs`, `src/main.rs` — register the module; register the custom method.
- Modify `src/server.rs` — `ClojureDocsParams`, `Backend.clojuredocs` state, path capture in `initialize`, `Backend::clojure_docs` handler.
- Create `tests/fixtures/clojuredocs/export.json` — tiny export in the official shape.
- Modify `tests/test_e2e.rs` — `initialize_with_options`, `clojure_docs` request helper, four tests.
- Modify `README.md`, `docs/ROADMAP2.md`.

**clojure-pulse-vscode (extension)**
- Create `scripts/build-clojuredocs.mjs` — download or read, strip, sort, write `data/clojuredocs.json`.
- Create `scripts/build-clojuredocs.test.mjs` — `node --test` tests for `stripExport`.
- Create `data/clojuredocs.json` — generated, committed.
- Create `src/clojureDocs.ts` — types, HTML renderer, message helpers.
- Create `src/clojureDocsPanel.ts` — panel controller.
- Create `src/test/clojureDocs.test.ts`, `src/test/clojureDocsPanel.test.ts`.
- Modify `src/extension.ts` — data path in init options; command registration.
- Modify `package.json` — command, keybinding, scripts. `Makefile` — `clojuredocs` target.
- Create `.github/workflows/clojuredocs-update.yml`.
- Modify `README.md`, `CHANGELOG.md`.

---

### Task 0: Feature branches

**Files:** none

- [x] **Step 1: Branch the server**
  Run: `git -C /home/agent/Projects/clj-pulse checkout -b feature/clojuredocs`
  Expected: `Switched to a new branch 'feature/clojuredocs'` (from a clean `master`).

- [x] **Step 2: Confirm the extension branch**
  The extension branch was created when this plan was committed. Run: `git -C /home/agent/Projects/clojure-pulse-vscode branch --show-current`
  Expected: `feature/clojuredocs`.

### Task 1: Server data model and loader

**Files:**
- Create: `/home/agent/Projects/clj-pulse/src/clojuredocs.rs`
- Modify: `/home/agent/Projects/clj-pulse/src/lib.rs`, `/home/agent/Projects/clj-pulse/src/main.rs`

- [x] **Step 1: Write the failing tests**
  In `src/clojuredocs.rs`, a `#[cfg(test)] mod tests` with a JSON literal in the export shape holding two vars (`clojure.core/map` with two examples, one see-also to `clojure.core/mapv`, `added`, `href`; `clojure.string/join` with no `added`, no `href`, and a `notes` array). Tests:
  - `parse` yields two entries; `get("clojure.core/map")` has `arglists == ["[f]", "[f coll]"]` from raw `"f"` and `"f coll"` (an already bracketed `"[x]"` stays as is), 2 example bodies, `see_alsos == ["clojure.core/mapv"]`, `added == Some("1.0")`, `url == "https://clojuredocs.org/clojure.core/map"`.
  - `clojure.string/join` parses with empty `arglists`, `added == None`, and `url` built from ns and name; notes are not represented anywhere on the entry.
  - Unknown top-level and per-var fields are ignored; a var missing `ns` or `name` is skipped, not an error.
  - `path_from_init_options(&json!({"clojuredocs": {"path": "/x/y.json"}}))` is `Some("/x/y.json")`; a missing key, a non-object, or `{"dependency-scheme": "jar"}` is `None`.
  - `load` on a nonexistent path is `Err`.

- [x] **Step 2: Run the tests to verify they fail**
  Run: `cd /home/agent/Projects/clj-pulse && cargo test clojuredocs`
  Expected: compile error (module does not exist yet).

- [x] **Step 3: Implement the module**
  Serde structs for the export: `Export { vars: Vec<RawVar> }`, `RawVar { ns: Option<String>, name: Option<String>, doc: Option<String>, arglists: Vec<String>, added: Option<String>, href: Option<String>, examples: Vec<RawExample{ body: Option<String> }>, see_alsos (rename "see-alsos"): Vec<RawSeeAlso{ to_var (rename "to-var"): Option<RawRef{ ns, name }> }> }`, all `#[serde(default)]`. Public `Entry` with the fields from the Protocol section (`see_alsos` as fqn strings, `url` computed from `href` or `/{ns}/{name}`, and each arglist normalized to `[…]`: the export stores `"f coll"`, so wrap it in brackets unless it already starts with `[`), `ClojureDocs { entries: HashMap<String, Entry> }` with `get(&self, fqn) -> Option<&Entry>`, `parse(&str) -> anyhow::Result<ClojureDocs>`, `load(&Path) -> anyhow::Result<ClojureDocs>`, `path_from_init_options(&serde_json::Value) -> Option<PathBuf>`. Register `pub mod clojuredocs;` in `src/lib.rs` and `mod clojuredocs;` in `src/main.rs`.

- [x] **Step 4: Run the tests to verify they pass**
  Run: `cd /home/agent/Projects/clj-pulse && cargo test clojuredocs`
  Expected: all `clojuredocs::tests` PASS.

- [x] **Step 5: Commit**
  `git -C /home/agent/Projects/clj-pulse add -A && git -C /home/agent/Projects/clj-pulse commit -m "Add ClojureDocs export data model and loader"`

> Deviation (Task 1): the raw export writes `null` for empty `examples`, `see-alsos`, `arglists`, and `doc` on hundreds of vars, which `#[serde(default)]` alone rejects. Added a null-tolerant `Vec` deserializer, a null-field test, and an ignored `loads_real_export_from_env` test (`CLJ_PULSE_CLOJUREDOCS_EXPORT=<file> cargo test clojuredocs -- --ignored`), verified against the current export. Found by the Task 1 codex review.

### Task 2: Server symbol resolution for ClojureDocs

**Files:**
- Create: `/home/agent/Projects/clj-pulse/src/handlers/clojuredocs.rs`
- Modify: `/home/agent/Projects/clj-pulse/src/handlers/mod.rs`

- [x] **Step 1: Write the failing tests**
  Inline `#[cfg(test)]` tests building an `Index` the way `tests/test_hover.rs` does (`scanner::build_index` over `tests/fixtures/simple_project` plus `core::core_symbols()`), and a second index built in memory: `extractor::extract("(ns demo (:require [clojure.string :as str]))", Path::new("demo.clj"))` fed to `Index::insert_file(meta, symbols, vec![])` on an `Index::new_with_core()`. Cases for `resolve_var(&index, word, current_ns)`:
  - `"map"` in `simple.core` → `Some("clojure.core/map")` (core symbol).
  - `"add"` in `simple.core` → `Some("simple.core/add")` (project symbol fqn).
  - `"if"` → `Some("clojure.core/if")` (special form).
  - `"str/join"` in the ns with the alias → `Some("clojure.string/join")` with nothing indexed for clojure.string (alias fallback).
  - `"clojure.set/union"` with no alias → `Some("clojure.set/union")` (literal fallback).
  - `"#'map"` and `"'map"` → `Some("clojure.core/map")`.
  - `"frobnicate"` → `Some("clojure.core/frobnicate")` (bare fallback; the lookup, not the resolver, decides existence).
  A test for `DocsResult` serialization: `serde_json::to_value` uses camelCase `seeAlsos` and serializes `entry: None` as `null`.

- [x] **Step 2: Run the tests to verify they fail**
  Run: `cd /home/agent/Projects/clj-pulse && cargo test handlers::clojuredocs`
  Expected: compile error.

- [x] **Step 3: Implement**
  `pub fn resolve_var(index: &Index, word: &str, current_ns: &str) -> Option<String>` following the Design's resolution order, reusing `super::resolve_symbol` and `index.ns_meta(current_ns)` for aliases. `#[derive(Serialize)] #[serde(rename_all = "camelCase")] pub struct DocsResult { pub symbol: Option<String>, pub entry: Option<DocsEntry> }` where `DocsEntry` is the wire shape from the Protocol section (build it from `clojuredocs::Entry`, or derive `Serialize` on `Entry` with the camelCase rename if that keeps one type; the executor picks whichever avoids a copy). `pub fn lookup(docs: &ClojureDocs, fqn: &str) -> DocsResult`. Add `pub mod clojuredocs;` to `src/handlers/mod.rs`.

- [x] **Step 4: Run the tests to verify they pass**
  Run: `cd /home/agent/Projects/clj-pulse && cargo test handlers::clojuredocs`
  Expected: PASS.

- [x] **Step 5: Commit**
  `git -C /home/agent/Projects/clj-pulse add src/handlers/clojuredocs.rs src/handlers/mod.rs && git -C /home/agent/Projects/clj-pulse commit -m "Resolve symbols to ClojureDocs entries"`

> Deviation (Task 2): the bare-word fallback now consults the ns form's `refers` map before trying clojure.core, so `(:require [clojure.string :refer [join]])` resolves to `clojure.string/join` even before that library is indexed. Found by the Task 2 codex review.

### Task 3: Server request wiring and e2e tests

**Files:**
- Modify: `/home/agent/Projects/clj-pulse/src/server.rs`, `/home/agent/Projects/clj-pulse/src/main.rs`
- Create: `/home/agent/Projects/clj-pulse/tests/fixtures/clojuredocs/export.json`
- Test: `/home/agent/Projects/clj-pulse/tests/test_e2e.rs`

- [x] **Step 1: Write the fixture export**
  `tests/fixtures/clojuredocs/export.json` in the official shape: `clojure.core/map` (doc, arglists, `added` "1.0", `href` "/clojure.core/map", two examples, see-alsos to `clojure.core/mapv` and `clojure.core/pmap`, one note that must not appear in responses) and `clojure.string/join` (doc, arglists, one example). Include `created-at` and an author object on the example to prove they are ignored.

- [x] **Step 2: Write the failing e2e tests**
  In `tests/test_e2e.rs` add to `LspClient`: `initialize_with_options(&mut self, root: &Path, options: Value) -> Value` (same body as `initialize`, `initializationOptions` replaced by `options`), and `clojure_docs(&mut self, params: Value) -> Value` calling `request_full("clojurePulse/clojureDocs", params)` so tests can assert on `result` or `error`. Tests, each on a fresh `setup_project()` with the fixture path passed as `{"clojuredocs": {"path": <abs path of tests/fixtures/clojuredocs/export.json>}}`:
  - `test_e2e_clojuredocs_bare_core_symbol`: write `src/docs_demo.clj` containing `(ns simple.docs-demo)\n(map inc [1 2 3])\n` before `initialize`, `did_open` it, request at line 1 character 1 → `result.symbol == "clojure.core/map"`, `entry.examples.len() == 2`, `entry.seeAlsos` contains `"clojure.core/mapv"`, `entry.url == "https://clojuredocs.org/clojure.core/map"`, and the JSON has no `notes` key.
  - `test_e2e_clojuredocs_aliased_symbol`: file with `(ns simple.docs-alias (:require [clojure.string :as str]))\n(str/join "," [1 2])\n`, request on `str/join` → `symbol == "clojure.string/join"`, one example.
  - `test_e2e_clojuredocs_direct_symbol_lookup`: `{"symbol": "clojure.core/pmap"}` → `symbol == "clojure.core/pmap"`, `entry` is `null`.
  - `test_e2e_clojuredocs_not_configured`: plain `initialize`, request → the message has an `error` whose `message` contains `not configured`.

- [x] **Step 3: Run the e2e tests to verify they fail**
  Run: `cd /home/agent/Projects/clj-pulse && cargo test --test test_e2e clojuredocs`
  Expected: FAIL (method not found, or `error` where `result` is expected).

- [x] **Step 4: Implement the request**
  In `src/server.rs`: `#[derive(serde::Deserialize)] pub(crate) struct ClojureDocsParams { text_document: Option<TextDocumentIdentifier>, position: Option<Position>, symbol: Option<String> }` with `#[serde(default, rename_all = "camelCase")]`; a `SharedClojureDocs` state type next to the other `Shared*` types; a `clojuredocs` field on `Backend` initialized in `Backend::new`; in `initialize`, store `clojuredocs::path_from_init_options(opts)` into the state (inside the existing `initialization_options` handling; keep the server tolerant of Calva's unrelated options). Handler `pub async fn clojure_docs(&self, params: ClojureDocsParams) -> jsonrpc::Result<handlers::clojuredocs::DocsResult>`: compute the fqn (`symbol` param wins; otherwise `documents.word_at` + `uri::to_index_path` + `index.file_ns`, then `resolve_var`; no word → `DocsResult { symbol: None, entry: None }`); then obtain the data via a small `fn docs(&self) -> Result<Arc<ClojureDocs>, String>` that loads lazily under the mutex, sets `failed` and logs once on failure, and returns `Err("ClojureDocs data not configured")` when no path is set. Map `Err(msg)` to `jsonrpc::Error { code: ErrorCode::InternalError, message: msg, data: None }`. Keep the server.rs method short; the logic sits in the handler module. Register `.custom_method("clojurePulse/clojureDocs", Backend::clojure_docs)` in `src/main.rs` with a comment like the neighbours.

- [x] **Step 5: Run the e2e tests to verify they pass**
  Run: `cd /home/agent/Projects/clj-pulse && cargo test --test test_e2e clojuredocs`
  Expected: 4 PASS.

- [x] **Step 6: Full check**
  Run: `cd /home/agent/Projects/clj-pulse && bb check && bb e2e`
  Expected: fmt clean, clippy clean with `-D warnings`, all tests pass.

- [x] **Step 7: Commit**
  `git -C /home/agent/Projects/clj-pulse add -A && git -C /home/agent/Projects/clj-pulse commit -m "Serve ClojureDocs entries over clojurePulse/clojureDocs"`

> Deviation (Task 3): the load-failure flag became `failed: Option<String>` and is checked before any re-read, so a broken export is parsed and logged once and later requests get the cached message; added `test_e2e_clojuredocs_unreadable_file`. Found by the Task 3 codex review.

### Task 4: Server docs

**Files:**
- Modify: `/home/agent/Projects/clj-pulse/README.md`, `/home/agent/Projects/clj-pulse/docs/ROADMAP2.md`

- [x] **Step 1: README**
  Under `## Features` add a bullet after Hover: **ClojureDocs** — the `clojurePulse/clojureDocs` request returns the ClojureDocs entry (docstring, arglists, examples, see-alsos) for the symbol at a position or for a given `ns/name`, resolved through the same alias-aware lookup as hover; served from a local file, never the network. Under `## Editor Setup` add a short subsection saying the data file is passed as `initializationOptions.clojuredocs.path`, that Clojure Pulse sends its bundled copy automatically, and that other editors can download `https://clojuredocs.org/clojuredocs-export.json` and point at it; the server reads the official export shape.

- [x] **Step 2: Roadmap**
  In `docs/ROADMAP2.md` tick the "Clojuredocs for built-ins" item and append " — served over `clojurePulse/clojureDocs` from an editor-supplied export file; hover enrichment still open."

- [x] **Step 3: Commit**
  `git -C /home/agent/Projects/clj-pulse commit -am "Document the ClojureDocs request"`

> Deviation (Task 4): README wording qualified so the not-configured error is described as raised only once a var is resolved or named; a position with no symbol still answers nulls. Found by the Task 4 codex review.

### Task 5: Data build script and initial data file

**Files:**
- Create: `scripts/build-clojuredocs.mjs`, `scripts/build-clojuredocs.test.mjs`, `data/clojuredocs.json`
- Modify: `package.json`, `Makefile`

- [x] **Step 1: Write the failing tests**
  `scripts/build-clojuredocs.test.mjs` using `node:test` and `node:assert/strict`, importing `{ stripExport, serialize }` from `./build-clojuredocs.mjs`. Cases: keeps only `ns, name, doc, arglists, added, href, examples[].body, see-alsos[].to-var{ns,name}`; drops `notes`, `created-at`, authors, `_id`; sorts by ns then name; skips a var without `ns` or `name`; tolerates missing `examples`/`see-alsos`/`arglists` (they become `[]`); an example without `body` is dropped; `serialize` output parses back to the same object and has one var per line (line count equals var count plus the wrapper lines).

- [x] **Step 2: Run the tests to verify they fail**
  Run: `node --test scripts/build-clojuredocs.test.mjs`
  Expected: FAIL, cannot find module.

- [x] **Step 3: Implement the script**
  ESM. `export function stripExport(raw)` and `export function serialize(stripped)` (the `{"description":…,"vars":[` wrapper, one `JSON.stringify(var)` per line, joined by `,\n`, trailing newline). `main()` runs only when the file is the entry point (`import.meta.url` versus `process.argv[1]`): source is `process.argv[2]` or the default `https://clojuredocs.org/clojuredocs-export.json`; an `http(s)` source is fetched with global `fetch` (Node 20), anything else read from disk; writes `data/clojuredocs.json` relative to the repo root (resolve from `import.meta.url`), creating `data/` if needed; prints the var and example counts. No dependencies.

- [x] **Step 4: Run the tests to verify they pass**
  Run: `node --test scripts/build-clojuredocs.test.mjs`
  Expected: PASS.

- [x] **Step 5: Wire scripts**
  `package.json` scripts: `"clojuredocs:update": "node scripts/build-clojuredocs.mjs"`, `"test:scripts": "node --test scripts/build-clojuredocs.test.mjs"`, and change `"test"` to `"npm run test:scripts && vscode-test"`. `Makefile`: `clojuredocs: ## Regenerate data/clojuredocs.json from the ClojureDocs export` running `npm run clojuredocs:update`; add it to the `.PHONY` list.

- [x] **Step 6: Generate the data file**
  Run: `npm run clojuredocs:update`
  Expected: `data/clojuredocs.json` written; the printed var count is about 1570 and examples about 2600. Run `node -e "const d=require('./data/clojuredocs.json');console.log(d.vars.length, Object.keys(d.vars[0]))"` and confirm the keys are exactly the kept set and no `notes` key exists anywhere: `grep -c '"notes"' data/clojuredocs.json` prints `0`.

- [x] **Step 7: Confirm packaging includes the data**
  Run: `npx vsce ls | grep data/clojuredocs.json`
  Expected: the path is listed (`.vscodeignore` does not exclude `data/`).

- [x] **Step 8: Commit**
  `git add scripts/build-clojuredocs.mjs scripts/build-clojuredocs.test.mjs data/clojuredocs.json package.json Makefile && git commit -m "Add ClojureDocs export build script and bundled data"`

### Task 6: Extension passes the data path to the server

**Files:**
- Modify: `src/extension.ts`

- [x] **Step 1: Implement**
  Add a module-level `let clojureDocsPath: string | undefined;` set in `activate` from `context.asAbsolutePath(path.join("data", "clojuredocs.json"))`. In `start()`, build the init options as `{ ...serverConfig(), clojuredocs: { path: clojureDocsPath } }` and pass that to `createClient`. Add a comment that the server reads this key only at `initialize`, so the `didChangeConfiguration` push (which sends `serverConfig()` alone) does not need it. Update the `createClient` doc comment in `src/client.ts` if it still says the object is only `{projects}`.

- [x] **Step 2: Compile and lint**
  Run: `npm run compile && npm run lint`
  Expected: clean.

- [x] **Step 3: Commit**
  `git commit -am "Send the bundled ClojureDocs path in initializationOptions"`

### Task 7: Renderer and message helpers

**Files:**
- Create: `src/clojureDocs.ts`
- Test: `src/test/clojureDocs.test.ts`

- [x] **Step 1: Write the failing tests**
  Mocha `suite("clojureDocs")` (tdd ui, as the other tests). Fixtures: a full result for `clojure.core/map` (doc containing `<b>` to test escaping, two examples, one with `<script>`, `added`, two see-alsos), and a minimal result (no doc, no added, no examples, no see-alsos). Cases for `renderClojureDocsHtml(result, "nonce")`:
  - contains `clojure.core/map`, both arglists, `Available since 1.0`, the escaped `&lt;b&gt;` and `&lt;script&gt;`, `Examples`, two `<pre>` example blocks, `See also`, anchors with `data-symbol="clojure.core/mapv"`, the footer link `https://clojuredocs.org/clojure.core/map`, the text `CC0`, and the nonce in both the CSP meta and the `<script nonce=`.
  - the minimal result contains no `Available since`, no `Examples`, no `See also`.
  For `describeClojureDocsFailure(error, version)`:
  - `{ code: -32601, message: "…" }` with version `"0.3.0"` → contains `0.4.0` and `0.3.0`; with version `undefined` → contains `0.4.0` and does not contain `undefined`.
  - `{ code: -32603, message: "ClojureDocs data not configured" }` → contains that message.
  - a plain `Error("boom")` → contains `boom`.
  For `noEntryMessage`: `"clojure.core/frob"` → contains the fqn; `null` → says the symbol could not be resolved.

- [x] **Step 2: Run the tests to verify they fail**
  Run: `make test`
  Expected: compile error for the missing module (the suite is compiled with `tsc` before running).

- [x] **Step 3: Implement**
  `src/clojureDocs.ts` with no `vscode` import: exported interfaces `ClojureDocsEntry`, `ClojureDocsResult` (the Protocol shapes), `CLOJUREDOCS_MIN_SERVER = "0.4.0"`, `CLOJUREDOCS_REQUEST = "clojurePulse/clojureDocs"`, an `escapeHtml` helper, `renderClojureDocsHtml`, `describeClojureDocsFailure` (detect method-not-found by `code === -32601` on the error object), `noEntryMessage`. The HTML follows the `renderHtml()` layout in `src/projectFormPanel.ts`: CSP with the nonce, theme variables, `pre { white-space: pre-wrap }` for the docstring and horizontal scroll for examples; the inline script wires `a[data-symbol]` clicks to `acquireVsCodeApi().postMessage({ type: "lookup", symbol })`.

- [x] **Step 4: Run the tests to verify they pass**
  Run: `make test`
  Expected: the new suite passes; everything else unchanged.

- [x] **Step 5: Commit**
  `git add src/clojureDocs.ts src/test/clojureDocs.test.ts && git commit -m "Render ClojureDocs entries to HTML"`

> Deviation (Task 7): the failing-test check used `npm run compile-tests` (the same tsc failure, without a minutes-long VS Code run); the passing check ran the full `make test` once (744 passing) and then only the ClojureDocs suites after tightening two assertions that had matched the footer's "Examples from ClojureDocs" text.

### Task 8: Panel controller

**Files:**
- Create: `src/clojureDocsPanel.ts`
- Test: `src/test/clojureDocsPanel.test.ts`

- [x] **Step 1: Write the failing tests**
  A fake host in the style of `src/test/projectFormPanel.test.ts` (`html`, `postMessage`, `onDidReceiveMessage`, `reveal`, `dispose`, `onDidDispose`, plus a `title`). A fake `lookup` recording its params and returning canned results. Cases:
  - `show({textDocument, position})` creates one panel, sets `title` to the fqn, and `html` contains `clojure.core/map`.
  - a second `show` reuses the panel: one `createPanel` call, `reveals === 1`.
  - `show` when `lookup` resolves `entry: null` returns the result and does not create a panel.
  - a `{ type: "lookup", symbol: "clojure.core/mapv" }` message from the webview calls `lookup({ symbol })` and re-renders (html now contains `clojure.core/mapv`); `settled()` resolves afterwards.
  - closing the tab resets so the next `show` creates a new panel.
  - `show` returns the `ClojureDocsResult` so the caller can decide on messages.
  - a see-also message whose `lookup` rejects calls the injected `onError` with the error and leaves `html` unchanged; `show` itself still rejects to its caller.
  - overlapping lookups: with a fake `lookup` returning deferred promises, resolve the second request first, then the first; the panel shows the second (a request sequence counter discards stale results).

- [x] **Step 2: Run the tests to verify they fail**
  Run: `make test`
  Expected: compile error for the missing module.

- [x] **Step 3: Implement**
  `ClojureDocsPanelHost` and `ClojureDocsPanelDeps { createPanel, lookup, onError: (error: unknown) => void }` interfaces mirroring `projectFormPanel.ts`, `class ClojureDocsPanel { show(params): Promise<ClojureDocsResult>; settled(): Promise<void>; dispose(): void }`. Every lookup increments a sequence number and only the newest request may render. Webview-initiated lookups (see-also clicks) run inside the panel, so their rejections are caught and passed to `onError`; the command's own `show` call rejects to the caller. Render with a fresh nonce per render via `crypto.randomBytes`. Ignore unknown messages. No `vscode` import.

- [x] **Step 4: Run the tests to verify they pass**
  Run: `make test`
  Expected: PASS.

- [x] **Step 5: Commit**
  `git add src/clojureDocsPanel.ts src/test/clojureDocsPanel.test.ts && git commit -m "Add the ClojureDocs panel controller"`

> Deviation (Task 8): `show` also re-renders an already open panel when the result has no entry, so a see-also click to an undocumented var shows the empty state instead of doing nothing; with no panel open the caller still gets the result and reports it.

> Deviation (Task 8, after review): the reused panel is revealed with `preserveFocus` so the cursor stays in the editor, and closing the tab invalidates in-flight lookups so a late answer cannot reopen it. Both found by the Task 8 codex review; the host's `reveal` slice now mirrors `WebviewPanel.reveal`'s arguments.

### Task 9: Command, keybinding, and wiring

**Files:**
- Modify: `src/extension.ts`, `package.json`

- [x] **Step 1: Contribute the command and keybinding**
  In `package.json` `contributes.commands` add `clojurePulse.showClojureDocs` with title `Show ClojureDocs`, matching the category and shape of the neighbouring commands. In `contributes.keybindings` add `{ "command": "clojurePulse.showClojureDocs", "key": "ctrl+alt+d", "when": "editorTextFocus && editorLangId == clojure" }`. In `menus.commandPalette` add a `when: "editorLangId == clojure"` entry for it, following the existing entries' form.

- [x] **Step 2: Wire the command**
  In `activate`, construct a `ClojureDocsPanel` with `createPanel` opening `vscode.window.createWebviewPanel("clojurePulse.clojureDocs", "ClojureDocs", { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }, { enableScripts: true, retainContextWhenHidden: true })` with the extension's activity icon as `iconPath`, `lookup: (params) => client!.sendRequest(CLOJUREDOCS_REQUEST, params)`, and `onError: (err) => vscode.window.showWarningMessage(describeClojureDocsFailure(err, client?.initializeResult?.serverInfo?.version))` so see-also failures surface the same way as the command's. Register the command: no active Clojure editor or no word range at the cursor → information message "Place the cursor on a symbol."; no `client` → "clj-pulse is not running."; otherwise `await panel.show({ textDocument: { uri: doc.uri.toString() }, position: { line, character } })`, and if the result's `entry` is `null` show `noEntryMessage(result.symbol)`. Wrap in try/catch and show `describeClojureDocsFailure(err, client.initializeResult?.serverInfo?.version)` as a warning. Push the panel into `context.subscriptions`.

- [x] **Step 3: Compile, lint, test**
  Run: `make check`
  Expected: clean.

- [x] **Step 4: Commit**
  `git commit -am "Add the Show ClojureDocs command and ctrl+alt+d binding"`

### Task 10: Monthly refresh workflow

**Files:**
- Create: `.github/workflows/clojuredocs-update.yml`

- [x] **Step 1: Write the workflow**
  Name `Update ClojureDocs data`. Triggers: `schedule: - cron: "0 6 1 * *"` and `workflow_dispatch`. `permissions: contents: write, pull-requests: write`. Steps: checkout, setup-node 20 with npm cache, `npm ci`, `npm run clojuredocs:update`, `npm run test:scripts`, then `peter-evans/create-pull-request@v7` with `commit-message: "Update bundled ClojureDocs data"`, `branch: chore/clojuredocs-update`, `title: "Update bundled ClojureDocs data"`, a body naming the source URL, and `delete-branch: true`. The action opens nothing when the tree is unchanged. Add a comment at the top that the repository setting "Allow GitHub Actions to create and approve pull requests" must be on.

- [x] **Step 2: Validate the YAML**
  Run: `node -e "require('js-yaml')" 2>/dev/null || npx --yes yaml-lint .github/workflows/clojuredocs-update.yml`
  Expected: no parse errors (either tool).

- [x] **Step 3: Commit**
  `git add .github/workflows/clojuredocs-update.yml && git commit -m "Refresh bundled ClojureDocs data monthly"`

### Task 11: Extension docs

**Files:**
- Modify: `README.md`, `CHANGELOG.md`

- [x] **Step 1: README**
  Use /writing-clearly. In `## Features` add a bullet **ClojureDocs, offline** after the Language intelligence bullet: `ctrl+alt+d` on a symbol opens its ClojureDocs entry (docstring, arglists, community examples, see-alsos) in a panel beside the editor; the data is bundled, so it works offline and needs no download. Add a `## ClojureDocs` section after `## Linting` describing the command, the binding and how to rebind it, see-also surfing inside the panel, that the bundled copy is refreshed monthly, that it needs clj-pulse 0.4.0 or newer, and the data licenses: examples CC0 from ClojureDocs, docstrings EPL from Clojure, notes not included. Add the command to the `## Commands` table. In `## License` add one sentence that `data/clojuredocs.json` is derived from the ClojureDocs export under those terms.

- [x] **Step 2: CHANGELOG**
  Add `## [Unreleased]` above `## [0.4.0]` with a **ClojureDocs, offline** entry in the existing style, naming the command, the default binding, the server requirement, and the licenses.

- [x] **Step 3: Commit**
  `git commit -am "Document the ClojureDocs panel"`

### Task 12: End-to-end verification

**Files:** none

- [x] **Step 1: Server checks**
  Run: `cd /home/agent/Projects/clj-pulse && bb check && bb e2e`
  Expected: all green.

- [x] **Step 2: Extension checks**
  Run: `make check && npm run package`
  Expected: green; a `clojure-pulse-0.4.0.vsix` is produced. Run `unzip -l clojure-pulse-*.vsix | grep clojuredocs.json` and confirm the file is inside.

- [x] **Step 3: Manual smoke (report the outcome, do not skip silently)**
  Build the server: `cd /home/agent/Projects/clj-pulse && cargo build`. In a VS Code window on any Clojure project with `"clojurePulse.server.path": "/home/agent/Projects/clj-pulse/target/debug/clj-pulse"`, install the vsix (`make install-extension`), open a `.clj` file, put the cursor on `map`, press `ctrl+alt+d`: a panel opens beside the editor with the docstring and examples, and clicking a see-also swaps the panel content. With the cursor on `str/join` (aliased) the entry for `clojure.string/join` appears. With an old server (`brew`/`mise` 0.3.0 on PATH) the warning names 0.4.0. If no display is available, state that the smoke run was not performed.

- [x] **Step 4: Wrap up**
  Both branches have all commits; no version bumps. Report the git log of each branch.

> Deviation (Task 12): no display is available for the manual smoke run, so it became a durable check: `src/test/clojureDocs.e2e.test.ts` drives the real command in the VS Code test host against the binary named by `CLJ_PULSE_E2E_BIN` (skipped when unset) and passed against `target/debug/clj-pulse`: the panel opens for `map`, is retitled for the aliased `str/join`, and focus stays in the editor. The old-server warning path is covered by unit tests only.

---

## Completion summary

**Implemented.** The server (clj-pulse, branch `feature/clojuredocs`, 9 commits) reads a ClojureDocs export file named in `initializationOptions.clojuredocs.path`, resolves the word at a position through `resolve_symbol` plus alias, refer, and clojure.core fallbacks, and answers `clojurePulse/clojureDocs` with `{symbol, entry}` or an error when no data is configured or readable. The extension (branch `feature/clojuredocs`, 10 commits after the plan) bundles `data/clojuredocs.json` (1572 vars, 2623 examples, 1.7 MB, about 450 KB in the vsix), passes its path at start, and adds **Show ClojureDocs** (`ctrl+alt+d` in Clojure editors) rendering the entry in a reusable webview beside the editor with in-place see-also navigation; a monthly workflow refreshes the data by pull request. Docs and changelog updated in both repos.

**Verification.** Server: `bb check` and `bb e2e` green (102 e2e tests, 5 new). Extension: `make check` green (757 tests incl. 8 renderer, 11 panel, 6 script tests), `npm run package` produces a 720 KB vsix containing the data file, and the gated end-to-end test passes against the locally built server.

**Issues encountered.** Per-task codex reviews found five real defects, all fixed in follow-up commits: null collections in the raw export (Task 1), referred vars from unindexed namespaces (Task 2), the load-failure cache that never short-circuited (Task 3), focus stolen by `reveal` and a late answer reopening a closed panel (Task 8). One test had a loose assertion matching the footer text (Task 7) and one hung on a never-resolving stub (Task 8); both were test bugs.

**Deviations, gathered.**
- Task 1: null-tolerant `Vec` deserializer; ignored `loads_real_export_from_env` test for a real download.
- Task 2: bare words consult the ns form's `refers` before the clojure.core fallback.
- Task 3: `failed: Option<String>` short-circuits re-reads of a broken file; extra e2e test.
- Task 4: README wording on when the not-configured error is raised.
- Task 7: `compile-tests` for the failing check; targeted suite reruns after tightening assertions.
- Task 8: empty state rendered in an already open panel; `reveal(undefined, true)`; close invalidates in-flight lookups.
- Task 12: manual smoke replaced by the gated end-to-end test.

**Not done, by design.** No version bumps: the server must be released as 0.4.0 for the extension's gate; the extension release is separate. The repository setting allowing Actions to open pull requests must be enabled before the monthly workflow can deliver.

**What the plan could have specified better.** The raw export's `null` collections and the `reveal(preserveFocus)` argument: both were knowable from the data and the VS Code API at planning time and each cost a review round.

> Post-completion change: the default `ctrl+alt+d` binding was removed at the user's request (F1 was ruled out because it is VS Code's Command Palette). The command ships without a default keybinding, like the eval commands; the README shows how to bind it.
