# External Libraries Search Implementation Plan

> **For agentic workers:** Use executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user type a query that narrows the External Libraries tree, in place, to the libraries and library files whose names match.

**Tech Stack:** TypeScript, VS Code extension API (`TreeView`, `InputBox`, context keys), Mocha through `@vscode/test-cli`. No clj-pulse server change.

---

## Design

### Problem

The External Libraries pane lists every resolved dependency, grouped by
project. A deps.edn project easily has a few hundred of them, each a lazy tree
of folders and files. Finding `aero/core.cljc`, or just the `aero` row, means
scrolling and expanding by hand. VS Code's built-in tree find only sees rows
that are already loaded, so it cannot find a file inside a collapsed jar.

### Behavior

- A **search** button (`$(search)`) in the view title, and the palette command
  **Clojure Pulse: Search External Libraries**, open an input box.
- The tree narrows **as the user types** (debounced 200 ms). Enter keeps the
  filter; Esc restores whatever filter was active when the box opened. The box
  opens prefilled with the active query, so it also serves to edit a filter.
- While a filter is active:
  - the view title shows the query as its description (`External Libraries  aero core`);
  - a **clear** button (`$(clear-all)`) appears in the view title;
  - submitting an empty query clears the filter, same as the clear button.
- The filter survives tree refreshes (rescan, `librariesChanged`, server
  restart): the tree re-filters the new data. It does not survive a window
  reload.
- When nothing matches, the view shows "No libraries or files match the
  filter." with a **Clear Filter** link, not the "No libraries resolved yet"
  guidance.

### Matching

- The query is split on whitespace into terms; matching is case-insensitive;
  **every** term must occur as a substring.
- A **library** matches when every term occurs in its label (`name version`,
  the row text). A matching library is shown whole — its contents are not
  pruned — and collapsed.
- Otherwise, a **file** matches when every term occurs in the haystack
  `"<library label> <entry path> <namespace form>"`, where the entry path is
  the file's path inside the jar or directory library (`aero/core.cljc`) and
  the namespace form is that path with the extension removed, `/` → `.`, and
  `_` → `-` (`aero.core`). So `aero core`, `aero/core`, and `aero.core` all
  find the file. A library with matching files is shown pruned to those files
  and their ancestor folders.
- A library with neither is hidden. A project with no surviving libraries is
  hidden.
- Expansion: project rows are expanded under a filter. Pruned libraries and
  their folders are expanded when the whole tree has at most
  `AUTO_EXPAND_LIMIT = 200` matching files, so a specific query shows its hits
  without clicks and a broad one (`clj`) does not unroll thousands of rows.

### Where the data comes from

File matching needs every library's entry list:

- **Jar libraries** — the existing `clojurePulse/libraryEntries` request, one
  per jar, through the existing `jarEntries` promise cache (so later expands
  and later queries reuse it). Requests for the index run at most 16 at a time.
  A jar whose request fails contributes no files (it can still match by name);
  the existing eviction lets a later query retry it.
- **Directory libraries** — a recursive `readDirectory` walk producing
  `/`-separated relative file paths. It skips directories whose name starts
  with `.` and does not descend into symbolic links (a linked file is still
  listed; this rules out cycles), stops at 5000 files per library (logging once when it truncates),
  and is cached per library path until `refresh()`, like jar entries.

The first query after a refresh pays for the index; the view shows a progress
bar ("Searching libraries…") until the filtered tree is ready. Later
keystrokes filter in memory.

### Structure

- `src/externalLibrariesFilter.ts` — pure, `vscode`-free matching:

  ```ts
  /** Lowercased whitespace-separated terms; empty array = no filter. */
  export function parseQuery(query: string): string[];
  /** What a library shows under `terms`: everything, only `entries`, or nothing. */
  export type LibraryMatch = { whole: true } | { whole: false; entries: string[] };
  export function matchLibrary(
    terms: string[], label: string, entries: string[],
  ): LibraryMatch | undefined;
  ```

- `ExternalLibrariesProvider` (`src/externalLibraries.ts`) gains the filter
  state and the filtered tree:

  ```ts
  /** The active query, "" when unfiltered. */
  get filter(): string;
  /** Sets (or, with "", clears) the filter and repaints. Settles once the
   *  filtered root for this query has been computed; never rejects. */
  setFilter(query: string): Promise<void>;
  ```

  The unfiltered code path stays as it is. Under a filter, `getChildren()`
  (root) loads the usual root (`rootChildren()` — projects, or the flat
  fallback list on an old server), builds the index for every library, runs
  `matchLibrary`, and returns precomputed filtered nodes. `LibNode` variants
  gain optional fields that only filtered nodes carry:

  - `project`: `children?: LibNode[]` — surviving library nodes;
  - `library`: `matches?: string[]` — pruned entry list (absent = whole);
  - `jarFolder`: `entries?: string[]` — the pruned list to fold from instead
    of the jar's full list;
  - `dirEntry`: `pruned?: { root: vscode.Uri; entries: string[]; prefix: string }`
    — fold children from the pruned relative paths instead of reading disk;
  - every expandable filtered node: `id?: string` and `expanded?: boolean`.

  Pruned jar and directory levels both come from the existing fold (generalize
  `foldJarLevel` into a fold over `(entries, prefix)` that yields folder names
  and file names; each caller maps them to its own node type).

  `getTreeItem` sets `item.id` and the collapsible state from `id`/`expanded`
  when present. Filtered ids embed the query and the node's position
  (`clojurePulseFilter:<query>:<project path>:<library path>:<prefix>`), so
  they are unique even when two projects share a library, and a new query
  starts from the computed expansion rather than VS Code's remembered state.
  The unfiltered project id (`clojurePulseProject:<path>`) is unchanged.

  `refresh()` also clears the directory-walk cache and keeps the query. A
  filtered root computed for a superseded generation or query is simply
  returned to its (stale) caller; correctness rests on the latest
  `getChildren()` reading the current query and caches.

- `src/extension.ts` wiring:
  - `registerTreeDataProvider` → `createTreeView("clojurePulse.externalLibraries", { treeDataProvider, showCollapseAll: true })`
    so the view's `description` can show the query. The existing
    `withProgress({ location: { viewId } })` progress is unaffected.
  - One helper, `applyLibrariesFilter(query)`: **synchronously, before any
    await**, sets `treeView.description` (query or `undefined`) and the
    context key `clojurePulse.externalLibrariesFiltered`, then calls
    `setFilter` inside a view-located `withProgress` ("Searching libraries…").
    Nothing is updated after the await, so a slow search that finishes after a
    clear or an Esc-restore cannot overwrite the newer UI state.
  - `clojurePulse.searchExternalLibraries`: `vscode.window.createInputBox()`
    with the prompt "Filter libraries and files by name", value = current
    filter; `onDidChangeValue` → debounced `applyLibrariesFilter`;
    `onDidAccept` → apply immediately, mark accepted, hide; `onDidHide` →
    if not accepted, re-apply the filter that was active on open; dispose.
  - `clojurePulse.clearExternalLibrariesSearch`: `applyLibrariesFilter("")`.

- `package.json`:
  - commands `clojurePulse.searchExternalLibraries` ("Search External
    Libraries", `$(search)`) and `clojurePulse.clearExternalLibrariesSearch`
    ("Clear External Libraries Search", `$(clear-all)`), category "Clojure Pulse";
  - `view/title` navigation entries: search always; clear with
    `when: view == clojurePulse.externalLibraries && clojurePulse.externalLibrariesFiltered`.
    Order with `navigation@N` so the row reads search, clear, refresh, add;
  - `commandPalette`: clear hidden (`"when": "false"`); search stays visible;
  - `viewsWelcome`: the existing entry gets
    `"when": "!clojurePulse.externalLibrariesFiltered"`; a new entry for the
    same view with `"when": "clojurePulse.externalLibrariesFiltered"` and
    contents `No libraries or files match the filter.\n\n[Clear Filter](command:clojurePulse.clearExternalLibrariesSearch)`.

### Decisions

- **Filter in place, by name** (user's choice) — not symbol or full-text
  search; those need server work and are out of scope.
- **Live filtering over a plain prompt** — the tree is the result list, so it
  should move as the query does. Cost: a debounce and an Esc-restores rule.
- **Whole library on a label match** — typing a library's name should show the
  library as it normally looks, not a list of every file in it.
- **Client-side index over a new server request** — reuses `libraryEntries`
  and its cache, works with every released server. Cost: one request per jar on
  the first query.
- **Filter is not persisted** across window reloads — a stale, forgotten filter
  hiding libraries is worse than retyping.

### Testing

Unit tests for the pure matcher; provider tests with the fake `sendRequest` /
`readDirectory` already used in `src/test/externalLibraries.test.ts`; manifest
and activation tests for the new commands. The input-box controller is thin
glue and is verified by hand (Task 5).

## File Structure

- Create: `src/externalLibrariesFilter.ts` — `parseQuery`, `matchLibrary`, namespace form.
- Create: `src/test/externalLibrariesFilter.test.ts` — matcher tests.
- Modify: `src/externalLibraries.ts` — filter state, index (jar entries with a concurrency cap, directory walk), filtered nodes.
- Modify: `src/test/externalLibraries.test.ts` — filtered-tree tests.
- Modify: `src/extension.ts` — tree view, the two commands, context key, description, progress.
- Modify: `package.json` — commands, menus, welcome views.
- Modify: `src/test/manifest.test.ts`, `src/test/extension.test.ts` — new command ids.
- Modify: `docs/projects.md`, `docs/reference.md`, `docs/features.md` — document the search.

Test command throughout: `make test` (runs lint, type-check, and the VS Code
test host under xvfb). Expected: all suites pass, 0 failing.

---

### Task 1: Pure matcher

**Files:**
- Create: `src/externalLibrariesFilter.ts`
- Test: `src/test/externalLibrariesFilter.test.ts`

- [x] **Step 1: Write failing tests** covering: `parseQuery` trims, lowercases,
  splits on any whitespace, and returns `[]` for blank input; a label match
  returns `{ whole: true }` regardless of entries; `aero core`, `aero/core`,
  `aero.core`, and `AERO CORE` each return only `aero/core.cljc` from
  `["META-INF/MANIFEST.MF", "aero/core.cljc", "aero/impl/walk.cljc"]` for the
  label `aero 1.1.6`; `_` → `-` in the namespace form (`my-ns` finds
  `my_ns/core.clj`); terms may be split between label and path; no match
  returns `undefined`; an entries-only match preserves the input order.
- [x] **Step 2: Run `make test`** — the new suite fails (module missing).
- [x] **Step 3: Implement** `parseQuery` and `matchLibrary` per the Design's
  Matching section. No `vscode` import.
- [x] **Step 4: Run `make test`** — PASS.
- [x] **Step 5: Commit** — `Add External Libraries name matcher`

### Task 2: Filtered tree in the provider

**Files:**
- Modify: `src/externalLibraries.ts`
- Test: `src/test/externalLibraries.test.ts`

- [x] **Step 1: Write failing tests** (grouped server and `flatServer` fallback where it matters):
  - `filter` is `""` initially; with no filter the tree is unchanged (existing tests keep passing);
  - a query matching a library label shows that library only, collapsed, and expanding it lists its full contents;
  - a query matching files shows the library pruned: only matching files and their ancestor folders, at every level;
  - non-matching libraries are hidden; a project with no surviving libraries is hidden; a surviving project is expanded;
  - a directory library is searched through a recursive fake `readDirectory`: matching files are found, dot-directories are skipped, and the pruned subtree's leaves open the right `file:` URIs;
  - pruned jar leaves keep the `jar:` URI shape of unfiltered leaves;
  - a library shared by two projects yields two nodes with distinct tree-item ids;
  - pruned libraries are `Expanded` at ≤ 200 matching files and `Collapsed` above;
  - jar entries are requested once per jar across two successive queries, and again after `refresh()`; the filter is still applied after `refresh()`;
  - a jar whose `libraryEntries` rejects still matches by name and does not break the rest of the tree;
  - `setFilter("")` restores the unfiltered tree, including the stable `clojurePulseProject:<path>` ids;
  - `setFilter` fires `onDidChangeTreeData` and its promise settles after the index loads;
  - with `libraryEntries` held on a deferred promise, `setFilter("x")` followed by `setFilter("")` before it resolves leaves the tree unfiltered once everything settles;
  - the directory walk does not descend into a symlinked directory (`FileType.Directory | FileType.SymbolicLink`).
- [x] **Step 2: Run `make test`** — the new tests fail.
- [x] **Step 3: Implement** per the Design's Structure section: the `filter`
  getter and `setFilter`; the generalized fold; the directory walk with its
  cache, dot-directory skip, and 5000-file cap; the 16-wide jar index load
  through `entriesFor`; filtered node construction; `getTreeItem` /
  `getChildren` handling of the new optional fields; `refresh()` clearing the
  walk cache.
- [x] **Step 4: Run `make test`** — PASS.
- [x] **Step 5: Commit** — `Filter the External Libraries tree by name`

> Deviation: codex hit its usage limit, so this task's review checkpoint used an independent Claude subagent instead. Its one should-fix — a failed project load was cached as the query's empty result, pinning "no matches" — is fixed in a follow-up commit, with added tests for the 200/201 auto-expand boundary and the 16-request cap.

### Task 3: Manifest

**Files:**
- Modify: `package.json`
- Test: `src/test/manifest.test.ts`

- [x] **Step 1: Update the test** — add `clojurePulse.searchExternalLibraries`
  to `PALETTE` (the clear command is hidden, so it is not listed).
- [x] **Step 2: Edit `package.json`** per the Design's `package.json` list:
  two commands, four ordered `view/title` entries for the view, the
  `commandPalette` hide, the two `viewsWelcome` entries.
- [x] **Step 3: Run `make test`** — manifest suite passes. (The activation
  test does not yet know the commands; they are registered in Task 4.)
- [x] **Step 4: Commit** — `Contribute External Libraries search commands`

### Task 4: Extension wiring

**Files:**
- Modify: `src/extension.ts`
- Test: `src/test/extension.test.ts`

- [x] **Step 1: Extend the activation test** to assert both new commands are registered.
- [x] **Step 2: Implement** per the Design's `src/extension.ts` list: switch to
  `createTreeView` (pushed to `context.subscriptions`), `applyLibrariesFilter`,
  the search command's input box with the 200 ms debounce and Esc-restores
  rule, the clear command. Clear any pending debounce timer on accept and hide.
- [x] **Step 3: Run `make test`** — PASS.
- [x] **Step 4: Commit** — `Add Search External Libraries command`

> Deviation: the search command first focuses the External Libraries view when it is hidden (e.g. run from the palette), since the tree is the result list. `applyLibrariesFilter` reads the trimmed query back from `setFilter` (synchronous) rather than setting UI state before calling it — same guarantee, nothing is updated after an await.
> Deviation (review fix): the input box sets `ignoreFocusOut`, since otherwise clicking a result in the tree hid the box and triggered the Esc-restore; a second search click re-shows the open box instead of stacking another. The filtered context key is reset to `false` on activation, as context keys outlive an extension-host restart.

### Task 5: Manual check and docs

**Files:**
- Modify: `docs/projects.md`, `docs/reference.md`, `docs/features.md`

- [ ] **Step 1: Manual check** in an Extension Development Host (F5) on a
  deps.edn project: search button opens the box; typing narrows the tree live;
  a library name shows the library whole; `<lib> <file>` and a dotted namespace
  find a file and clicking it opens the read-only source; Esc restores the
  previous filter; Enter keeps it and the title shows the query; the clear
  button and an empty submit both restore the full tree; a nonsense query shows
  the "No libraries or files match" welcome with a working Clear Filter link;
  refresh keeps the filter. If no display is available to the executor, say so
  in the final report rather than claiming this step.
- [ ] **Step 2: Docs** — `docs/projects.md`: a short paragraph in "External
  Libraries" on searching (what matches, live narrowing, clearing).
  `docs/reference.md`: a row for `clojurePulse.searchExternalLibraries` in the
  table that holds Refresh External Libraries, and a row for the clear command
  (view button only). `docs/features.md`: mention search in the External
  Libraries bullet. Use /writing-clearly.
- [ ] **Step 3: Run `make test`** — PASS.
- [ ] **Step 4: Commit** — `Document External Libraries search`
