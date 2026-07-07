# External Libraries Panel Implementation Plan

> **For agentic workers:** Use executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Cursive-style "External Libraries" tree view to the left sidebar that lists every library the clj-pulse server resolved for the project (deps.edn, lgx.edn, Leiningen best-effort) and opens library files read-only.

**Tech Stack:** Rust (clj-pulse server: tower-lsp, zip crate), TypeScript (VS Code extension: TreeDataProvider, vscode-languageclient).

**Cross-repo:** Tasks 1-4 change the server at `/Users/andrew/Projects/clj-pulse`; Tasks 5-8 change this extension. Start the executing session with `/Users/andrew/Projects/clj-pulse` added as a working directory.

---

## Design

### Approach

clj-pulse already resolves each project's libraries: deps.edn via the `.cpcache` classpath (full transitive set, `classpath::discover`), Leiningen via a direct-deps fallback (`leiningen::resolve`), and lgx via `lgx::resolve`. It also already serves jar file contents through `clojure/dependencyContents`, which the extension's existing `jar:` content provider renders read-only. The panel therefore stays thin: two new custom LSP requests and one notification on the server, plus a lazy `TreeDataProvider` in the extension. This mirrors the pattern `clojurePulse/ignoredForms` established (server computes, client renders, the request closure re-resolves the current client so it survives restarts).

### Protocol (shared contract, both repos must match exactly)

**`clojurePulse/externalLibraries`** (request, params `{}`) returns the resolved libraries:

```json
[
  { "name": "aero", "version": "1.1.6", "path": "/home/u/.m2/repository/aero/aero/1.1.6/aero-1.1.6.jar", "kind": "jar" },
  { "name": "babashka/fs", "version": "0.5.30", "path": "...", "kind": "jar" },
  { "name": "my-local-lib", "path": "/abs/path/to/lib", "kind": "dir" }
]
```

- `name`: `group/artifact`, collapsed to `artifact` when group equals artifact (Cursive convention: `aero`, not `aero/aero`).
- `version`: omitted when unknown (for example a `:local/root` dir). For git deps it is the short sha (first 7 chars).
- `kind`: `"jar"` or `"dir"`.
- Sorted by `name`, then `version`.
- Entries under the project root (the project's own `src`, `resources`) are excluded.

**`clojurePulse/libraryEntries`** (request, params `{ "path": "/abs/path/to.jar" }`) returns the jar's file entries as a flat, sorted list of strings, directories excluded:

```json
["META-INF/MANIFEST.MF", "aero/alpha/core.cljc", "aero/core.cljc"]
```

Errors with invalid-params when `path` is not an existing `.jar` file. Only called for `kind: "jar"`; the client reads `dir` libraries from disk itself.

**`clojurePulse/librariesChanged`** (notification, no params) is pushed by the server whenever library (re)indexing completes, so the panel refreshes without polling.

### Server side (clj-pulse)

- New module `src/libraries.rs`: a pure function that maps resolved classpath entries to the library list above. Path patterns to parse (read `classpath.rs`, `leiningen.rs`, and `lgx.rs` first to confirm the exact shapes each resolver returns):
  - Maven jar: `<m2>/repository/<group segments...>/<artifact>/<version>/<artifact>-<version>.jar`. Group is the segments joined with dots. A jar that does not match this shape falls back to its file stem as `name`, no version.
  - gitlibs dir: `<gitlibs>/libs/<group>/<artifact>/<sha>/`. Name `group/artifact`, version = short sha. lgx's gitlibs layout is analogous; confirm in `lgx.rs`.
  - Any other dir (for example `:local/root`): basename as `name`, no version.
- The request handler re-derives the entry list the same way `resolve_and_index_libs` does (`config::project_kind`, then `classpath::discover` with `leiningen::resolve` fallback, or `lgx::resolve`). It does not cache; reading `.cpcache` is cheap and re-deriving avoids new server state.
- `jar_content.rs` gains `list_entries(jar_path) -> anyhow::Result<Vec<String>>` using the existing `zip` crate.
- The notification is sent from the two places where library indexing already completes with a `client` clone in scope: the background task in `initialize` (near server.rs:246) and the classpath-change re-index in `did_change_watched_files` (near server.rs:619). Send it on success and on the zero-entries path, so the panel clears when deps disappear.

### Extension side (this repo)

- New activity-bar container "Clojure Pulse" (left sidebar, own SVG icon) holding one tree view, `clojurePulse.externalLibraries` ("External Libraries"). Future views (REPL sessions, test runner) can join this container later.
- `src/externalLibraries.ts`: `ExternalLibrariesProvider implements vscode.TreeDataProvider`. Built around an injected `sendRequest` function (same testability seam as `jarContentProvider.ts`) plus an injected directory reader for `dir` libraries.
  - Roots: one node per library, label `name version` with a library icon.
  - Expanding a jar library calls `libraryEntries` once, folds the flat list into a folder tree, and caches it until the next refresh.
  - Expanding a `dir` library (or one of its subfolders) reads the directory lazily via `vscode.workspace.fs.readDirectory`. No caching needed; the fs read is already lazy per node.
  - Folders sort before files; both alphabetical.
- Opening files: a jar entry opens as `jar:<jar file URI>!/<entry>` (exactly the format `uri::from_index_path` produces, for example `jar:file:///x.jar!/aero/core.cljc`), served read-only by the existing `jar:` content provider. Files of `dir` libraries open as ordinary file documents; VS Code does not force read-only on `file:` URIs and v1 does not fight that.
- Refresh triggers: the `clojurePulse/librariesChanged` notification, the client reaching `Running`, and a manual `clojurePulse.refreshExternalLibraries` command shown as a refresh icon on the view title.
- Empty state via `viewsWelcome`: "No libraries resolved yet" with the per-project-type hints the server already logs (deps.edn: run `clojure -Spath` or start a REPL once to create `.cpcache`; lein: direct deps only, best effort; lgx: run `lgx run` or `lgx build` once).

### Key decisions

- **Server-driven, not client-side parsing.** The server already owns resolution for all three project types; duplicating `.cpcache`/lein/lgx logic and zip reading in TypeScript would be strictly worse.
- **Full transitive classpath for deps.edn** (like Cursive's screenshot); Leiningen stays direct-deps-only, matching the server's existing best-effort resolver.
- **Own activity-bar container** rather than a section inside Explorer.
- **JDK node out of scope for v1.** Natural follow-up; the server has a JDK index already.
- **No new server state.** `externalLibraries` re-derives from disk per request.

### Error handling

- Server not running: the tree shows the welcome/empty state; requests are never sent. All provider requests go through a closure that rejects when `client` is undefined (same as `jarContentProvider`).
- `libraryEntries` on a jar that disappeared (cleaned `~/.m2`): the node shows no children and the failure is logged to the output channel; no error popups for a background tree.
- Malformed paths parse to fallback names rather than erroring; the panel always renders something for every classpath entry.

### Testing strategy

- Rust: unit tests for `libraries.rs` path parsing (m2 jar, non-m2 jar, gitlibs dir, local dir, project-root exclusion, sorting, group==artifact collapse) and for `list_entries` (reuses the existing in-test jar-building pattern from `jar_content.rs`). Run with `bb test` (wraps `cargo test`).
- TypeScript: unit tests for the provider with a fake `sendRequest`/fake dir reader (roots, tree folding, jar URI construction, caching, refresh clears cache), following `src/test/jarContentProvider.test.ts` conventions. Run with `npm test`.
- One extension integration check: activation registers the view and the refresh command (extend `src/test/extension.test.ts`).

## File Structure

**clj-pulse (`/Users/andrew/Projects/clj-pulse`):**

- Create: `src/libraries.rs` - pure classpath-entries → library-list derivation (parsing, exclusion, sorting)
- Modify: `src/lib.rs` - register the new module
- Modify: `src/jar_content.rs` - add `list_entries`
- Modify: `src/server.rs` - request handlers `external_libraries` / `library_entries`, params/result structs, `librariesChanged` notification at the two indexing-completion sites
- Modify: `src/main.rs` - `.custom_method("clojurePulse/externalLibraries", ...)` and `.custom_method("clojurePulse/libraryEntries", ...)` (next to the existing custom methods, main.rs:60-69)

**clojure-pulse-vscode (this repo):**

- Create: `src/externalLibraries.ts` - tree data provider, node types, flat-list → tree folding, jar URI builder
- Create: `images/activity-icon.svg` - activity-bar icon (monochrome outline style, like `repl-icon.svg`)
- Create: `src/test/externalLibraries.test.ts`
- Modify: `package.json` - `viewsContainers.activitybar`, `views`, `viewsWelcome`, `clojurePulse.refreshExternalLibraries` command, `menus.view/title`
- Modify: `src/extension.ts` - construct/register the provider, wire refresh triggers and the open-file command
- Modify: `src/test/extension.test.ts` - activation registers view + command
- Modify: `README.md`, `CHANGELOG.md`

## Tasks

### Task 1: Library list derivation (`libraries.rs`)

**Files:**
- Create: `/Users/andrew/Projects/clj-pulse/src/libraries.rs`
- Modify: `/Users/andrew/Projects/clj-pulse/src/lib.rs`

- [ ] **Step 1: Read the resolvers to confirm path shapes**
  Read `src/classpath.rs`, `src/leiningen.rs`, `src/lgx.rs` (especially `lgx::resolve` and `leiningen::resolve` return values) and note the exact m2/gitlibs/lgx directory layouts.

- [ ] **Step 2: Write failing unit tests**
  In `src/libraries.rs` `#[cfg(test)]`: an m2 jar path parses to name/version (`babashka/fs` 0.5.30 style and collapsed `aero` 1.1.6 style); a non-m2 jar falls back to file stem; a gitlibs dir yields `group/artifact` + 7-char sha; an unrecognized dir yields its basename with no version; entries under the project root are excluded; output is sorted by name then version. Define the public shape here since the handler and tests share it:
  ```rust
  #[derive(serde::Serialize, PartialEq, Debug)]
  pub struct Library {
      pub name: String,
      #[serde(skip_serializing_if = "Option::is_none")]
      pub version: Option<String>,
      pub path: String,
      pub kind: LibraryKind, // serializes as "jar" | "dir"
  }
  pub fn from_entries(root: &Path, entries: &[PathBuf]) -> Vec<Library>
  ```

- [ ] **Step 3: Run tests to verify they fail**
  Run: `cargo test libraries` (in `/Users/andrew/Projects/clj-pulse`)
  Expected: FAIL (module compiles, assertions fail) or compile error before implementation exists.

- [ ] **Step 4: Implement**
  Pure string/path logic; no filesystem access (testable with fabricated paths). Add `pub mod libraries;` to `lib.rs`.

- [ ] **Step 5: Run tests to verify they pass**
  Run: `cargo test libraries`
  Expected: PASS

- [ ] **Step 6: Commit** (in clj-pulse)
  `git commit -m "Add classpath-to-library-list derivation"`

### Task 2: Jar entry listing

**Files:**
- Modify: `/Users/andrew/Projects/clj-pulse/src/jar_content.rs`

- [ ] **Step 1: Write failing test**
  Build a small jar in-test (reuse the existing test-jar pattern in `jar_content.rs`); assert `list_entries` returns files only (no directory entries), sorted; assert a missing jar errors.

- [ ] **Step 2: Run test to verify it fails**
  Run: `cargo test jar_content`
  Expected: FAIL / compile error.

- [ ] **Step 3: Implement `list_entries`**
  `pub fn list_entries(jar_path: &Path) -> anyhow::Result<Vec<String>>` over `zip::ZipArchive`, skipping entries whose name ends with `/`.

- [ ] **Step 4: Run test to verify it passes**
  Run: `cargo test jar_content`
  Expected: PASS

- [ ] **Step 5: Commit** (in clj-pulse)
  `git commit -m "Add jar entry listing"`

### Task 3: Custom LSP requests

**Files:**
- Modify: `/Users/andrew/Projects/clj-pulse/src/server.rs`
- Modify: `/Users/andrew/Projects/clj-pulse/src/main.rs`

- [ ] **Step 1: Add handlers on `Backend`**
  `external_libraries` (params `{}` or absent): resolve the project root from `self.root`; derive entries the same way `resolve_and_index_libs` does (match on `config::project_kind`; `classpath::discover` with `leiningen::resolve` fallback for Clojure, `lgx::resolve` for let-go); return `libraries::from_entries(...)`. No root yet → empty list, never an error.
  `library_entries` (params `{ path: String }`): reject non-`.jar` or missing paths with `invalid_params`; return `jar_content::list_entries`.

- [ ] **Step 2: Register both methods in `main.rs`**
  `.custom_method("clojurePulse/externalLibraries", Backend::external_libraries)` and `.custom_method("clojurePulse/libraryEntries", Backend::library_entries)` next to `clojurePulse/ignoredForms` (main.rs:60-69).

- [ ] **Step 3: Verify build and full test suite**
  Run: `bb check` (fmt-check, clippy, tests)
  Expected: PASS

- [ ] **Step 4: Smoke-test against a real project (optional but cheap)**
  If an e2e harness pattern in `tests/test_e2e` makes it easy, add one case that calls `clojurePulse/externalLibraries` on the `tests/fixtures/simple_project` fixture; otherwise skip.

- [ ] **Step 5: Commit** (in clj-pulse)
  `git commit -m "Add externalLibraries and libraryEntries custom LSP methods"`

### Task 4: `librariesChanged` notification

**Files:**
- Modify: `/Users/andrew/Projects/clj-pulse/src/server.rs`

- [ ] **Step 1: Define the notification type**
  A zero-params tower-lsp custom notification (`impl Notification`, `METHOD = "clojurePulse/librariesChanged"`).

- [ ] **Step 2: Send it at both indexing-completion sites**
  The background lib-index task in `initialize` (near server.rs:246) and the classpath-change re-index in the watched-files handler (near server.rs:619). Send on success and on the zero-entries early returns, so a removed `.cpcache` clears the panel.

- [ ] **Step 3: Verify**
  Run: `bb check`
  Expected: PASS

- [ ] **Step 4: Commit** (in clj-pulse)
  `git commit -m "Notify client when library index changes"`

### Task 5: Extension contributions (package.json + icon)

**Files:**
- Create: `images/activity-icon.svg`
- Modify: `package.json`

- [ ] **Step 1: Add the activity-bar icon**
  24x24 monochrome outline SVG (`currentColor`), visually consistent with `images/repl-icon.svg`.

- [ ] **Step 2: Add contributions**
  `viewsContainers.activitybar`: id `clojurePulseSidebar`, title "Clojure Pulse", the new icon. `views.clojurePulseSidebar`: tree view id `clojurePulse.externalLibraries`, name "External Libraries". `viewsWelcome` for that view with the empty-state text and hints (deps.edn: run `clojure -Spath` or start a REPL once; lein: direct deps, best effort; lgx: run `lgx run`/`lgx build` once). Command `clojurePulse.refreshExternalLibraries` ("Refresh External Libraries", icon `$(refresh)`) plus a `menus."view/title"` entry with `"when": "view == clojurePulse.externalLibraries"`, `"group": "navigation"`.

- [ ] **Step 3: Verify it compiles and lints**
  Run: `npm run compile && npm run lint`
  Expected: PASS

- [ ] **Step 4: Commit** (in this repo)
  `git commit -m "Add Clojure Pulse sidebar container and External Libraries view contributions"`

### Task 6: Tree data provider

**Files:**
- Create: `src/externalLibraries.ts`
- Test: `src/test/externalLibraries.test.ts`

- [ ] **Step 1: Write failing unit tests**
  With a fake `sendRequest` (and a fake dir reader): roots map libraries to `name version` labels; a jar node's children come from one `libraryEntries` call folded into folders-before-files, alphabetical; the fold handles nested paths (`aero/impl/walk.cljc`); the jar entry leaf carries the exact URI `jar:file:///abs/to.jar!/aero/impl/walk.cljc`; `libraryEntries` is called once per jar until `refresh()`; a rejected request yields empty children (no throw); `dir` libraries read children via the injected dir reader.

- [ ] **Step 2: Run tests to verify they fail**
  Run: `npm test`
  Expected: FAIL / compile error for the new module.

- [ ] **Step 3: Implement the provider**
  `ExternalLibrariesProvider implements vscode.TreeDataProvider<LibNode>` with an `onDidChangeTreeData` emitter and `refresh()` that clears caches and fires. Constructor takes `sendRequest` (same `SendRequest` shape as `jarContentProvider.ts`) and a dir-reader function defaulting to `vscode.workspace.fs.readDirectory`. Node kinds: library root, folder (inside jar or dir), file. File nodes get `command: vscode.open` with the `jar:` URI (built via `vscode.Uri.file(jarPath)` then `jar:${fileUri}!/${entry}` string parse, matching the server's `parse_jar_uri`) or the plain file URI for dir libraries. Use `ThemeIcon("library")` for roots; default folder/file icons elsewhere.

- [ ] **Step 4: Run tests to verify they pass**
  Run: `npm test`
  Expected: PASS

- [ ] **Step 5: Commit**
  `git commit -m "Add External Libraries tree data provider"`

### Task 7: Wire the provider into activation

**Files:**
- Modify: `src/extension.ts`
- Test: `src/test/extension.test.ts`

- [ ] **Step 1: Register the view and refresh triggers**
  In `activate`: construct the provider with the same resolve-client-per-request closure used for the jar content provider; `vscode.window.registerTreeDataProvider` (or `createTreeView`) for `clojurePulse.externalLibraries`; register `clojurePulse.refreshExternalLibraries` → `provider.refresh()`. In `start()`'s state listener, call `provider.refresh()` when the state becomes `Running`; register `client.onNotification("clojurePulse/librariesChanged", ...)` → `provider.refresh()` on each new client (inside `start()`, since handlers do not carry across clients).

- [ ] **Step 2: Extend the activation integration test**
  Assert `clojurePulse.refreshExternalLibraries` is among registered commands after activation (mirror the existing command assertions in `extension.test.ts`).

- [ ] **Step 3: Run tests**
  Run: `npm test`
  Expected: PASS

- [ ] **Step 4: Manual verification (Extension Development Host)**
  F5 with a deps.edn project that has `.cpcache`: sidebar icon appears; libraries listed sorted with versions; expanding a jar shows its folder tree; clicking a `.clj` file opens it read-only via `jar:`; editing deps.edn + re-running `clojure -Spath` refreshes the panel; the refresh button works; an lgx project shows dir libraries browsable from disk.

- [ ] **Step 5: Commit**
  `git commit -m "Wire External Libraries panel into activation"`

### Task 8: Docs

**Files:**
- Modify: `README.md`, `CHANGELOG.md`

- [ ] **Step 1: Document the panel**
  README feature entry (what it shows per project type, read-only jar viewing, lein best-effort caveat); CHANGELOG entry.

- [ ] **Step 2: Final check**
  Run: `npm run pretest`
  Expected: PASS (compile, lint, tests all green)

- [ ] **Step 3: Commit**
  `git commit -m "Document External Libraries panel"`
