# Projects Panel & Monorepo Config Implementation Plan

> **For agentic workers:** Use executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **STATUS: COMPLETED** (2026-08-23) — all 5 tasks implemented, reviewed, and verified. See the completion summary at the end.

**Goal:** Configure clj-pulse's multi-project (monorepo) support from the extension — a `clojurePulse.projects` setting forwarded via `initializationOptions` and live `didChangeConfiguration`, and an External Libraries view grouped by project with a per-project classpath-resolution toggle.

**Tech Stack:** TypeScript, VS Code extension API, vscode-languageclient 9.x.

**Depends on:** clj-pulse's multi-project support (its plan: `clj-pulse/docs/plans/2026-08-23-0158-multi-project-monorepo.md`) — specifically the `clojurePulse/projects` request, the `{"clojurePulse": {"projects": [...]}}` config shape, and per-project status values. Implement against a clj-pulse build that has it; the panel falls back to today's flat list against older servers.

---

## Design

### What the server provides (contract)

- Config shape, sent both as `initializationOptions` and as `workspace/didChangeConfiguration` settings under the `clojurePulse` key:
  ```json
  {"projects": [{"path": "apps/backend",
                 "classpath": {"enabled": true, "cmd": "clojure -A:dev:test -Spath"}}]}
  ```
  Entries are overrides over server-side detection/defaults; `path` is workspace-root-relative, `"."` = root.
- Request `clojurePulse/projects` → array of:
  ```json
  {"path": ".", "kind": "deps",
   "classpath": {"enabled": true, "cmd": "clojure -A:dev:test -Spath",
                 "status": "disabled|cached|resolving|resolved|unresolved|error",
                 "message": "only when status=error"},
   "libraries": [{"name": "...", "version": "...", "path": "...", "kind": "jar|dir"}]}
  ```
- Existing `clojurePulse/librariesChanged` notification also fires on project/status changes.
- Old `clojurePulse/externalLibraries` (flat list) still exists — the fallback when `clojurePulse/projects` is not supported (method-not-found).

### Extension changes

**Setting** `clojurePulse.projects` (resource scope, workspace settings — same "settings.json is the source of truth, the view follows" philosophy as `replConfigurations`): array of `{ "path": string, "classpathEnabled"?: boolean, "classpathCommand"?: string }`. The flat editor-facing keys are translated to the server's nested `{classpath: {enabled, cmd}}` shape by one mapping function used by both channels. Invalid entries are skipped with a line in the output channel, the rest keep working (same policy as REPL configs).

**Plumbing** (`client.ts`, `extension.ts`):
- `createClient` gains `initializationOptions: { projects: <mapped setting> }` read at start.
- The existing `onDidChangeConfiguration` listener additionally reacts to `clojurePulse.projects` by sending `DidChangeConfigurationNotification` with `{ settings: { clojurePulse: { projects: <mapped setting> } } }` to the running client — explicitly via `client.sendNotification` (no `synchronize` section; we control the payload shape). No server restart on toggle.

**Panel** (`externalLibraries.ts`): the view keeps its name and container. The tree gains one level:
- Top-level: one node per project — label = `path` (root shown as the workspace folder name), description = kind + status (e.g. `deps · resolving…`), icons: `root-folder`/`folder`; `error` status carries the message in the tooltip.
- Inline action per project node: **toggle classpath resolution** (icon reflects state), plus a context-menu command. The toggle writes `clojurePulse.projects` (updating or inserting the entry for that path) to workspace settings; the config listener pushes it to the server; `librariesChanged` refreshes the tree — the panel never mutates its own state directly.
- Children of a project node: that project's `libraries`, rendered by the **existing** library/jar/dir node code unchanged.
- Fallback: if `clojurePulse/projects` rejects (older server), render exactly today's flat list from `externalLibraries`.

**Out of scope** (explicitly): REPL changes (the existing `cwd` field already covers subproject REPLs), eval routing, status bar, jar content provider — single client/server throughout.

### Testing

Existing suite style: unit tests in `src/test/*.test.ts` run inside a real VS Code (`make test`). The provider is already injectable (`SendRequest`), so grouped-tree tests follow `externalLibraries.test.ts` patterns with a fake `sendRequest`. Config mapping and toggle-write logic get pure unit tests, mirroring `replConfig.test.ts`.

## File Structure

- Create: `src/projects.ts` — setting parse/validate + mapping to the server shape + toggle write helper. Pure, unit-testable.
- Create: `src/test/projects.test.ts`
- Modify: `src/client.ts` — `initializationOptions`.
- Modify: `src/extension.ts` — config-change push, toggle command registration.
- Modify: `src/externalLibraries.ts` — project grouping + fallback.
- Modify: `src/test/externalLibraries.test.ts` — grouped-tree cases.
- Modify: `package.json` — setting schema, commands, view/item menus.
- Modify: `README.md`.

---

### Task 1: Setting schema and `src/projects.ts`

**Files:**
- Create: `src/projects.ts`, `src/test/projects.test.ts`
- Modify: `package.json`

- [x] **Step 1: Write failing tests**
  For three functions:
  - `parseProjects(raw: unknown)` — returns valid entries **and** the skip reasons, following the exact error-reporting shape `parseReplConfigurations` uses (`src/repl/replConfig.ts`), so the caller logs them to the output channel; never silently drops.
  - `toServerConfig(entries: ProjectSetting[]): {projects: ...}` — flat keys → nested `classpath` shape; omitted keys omitted, not defaulted (the server owns defaults).
  - `withToggled(raw: unknown[], path: string, enabled: boolean): unknown[]` — operates on the **raw** setting value, preserving invalid/unrecognized entries and unknown keys verbatim; only the entry matching `path` is updated (or a minimal `{path, classpathEnabled}` entry inserted). Path matching normalizes `./foo` vs `foo`, trailing slashes, and whitespace; a duplicate-path entry updates the first match. Once set, `classpathEnabled` stays explicit — no removal when it happens to equal the server default.

- [x] **Step 2: Run to verify failure**
  Run: `make test`
  Expected: FAIL on the new file.

- [x] **Step 3: Implement + declare the setting**
  `package.json` `contributes.configuration`: `clojurePulse.projects`, `scope: "resource"`, array of objects with `path` (required string), `classpathEnabled` (boolean), `classpathCommand` (string); description notes paths are workspace-root-relative and entries override server auto-detection — or **add** a project detection missed (e.g. a subproject under a gitignored directory).

- [x] **Step 4: Run to verify pass**
  Run: `make test`
  Expected: PASS.

- [x] **Step 5: Commit**
  `git commit -m "feat: clojurePulse.projects setting and mapping"`

> Codex review (commit 6cbcb5d): two P2 findings, both fixed in c68dea5 — backslash separators now normalize to `/` (matching the server), and absolute/`..` paths are skipped with a warning instead of silently forwarded.

### Task 2: initializationOptions + live config push

**Files:**
- Modify: `src/client.ts`, `src/extension.ts`

- [x] **Step 1: Wire both channels**
  `createClient` accepts the mapped server config and sets `clientOptions.initializationOptions`. In `extension.ts`, read + map the setting at `start()`; extend the existing `onDidChangeConfiguration` handler: when `clojurePulse.projects` changes and a client is running, `client.sendNotification(DidChangeConfigurationNotification.type, { settings: { clojurePulse: toServerConfig(...) } })`. (Import the notification type from `vscode-languageclient`.)

- [x] **Step 2: Manual smoke via extension host**
  F5 host on a monorepo fixture with a multi-project clj-pulse build: server log shows the initOptions-provided overrides; editing the setting logs a config reload without restart.
  > Deviation: no interactive F5 host available in this session — substituted a scripted stdio LSP smoke (scratchpad/smoke.js) driving the real `clj-pulse` debug binary with the extension's exact payloads: initOptions override applied at startup, didChangeConfiguration flipped the project live (no restart), `librariesChanged` fired.

- [x] **Step 3: Run the suite**
  Run: `make check`
  Expected: PASS.

- [x] **Step 4: Commit**
  `git commit -m "feat: forward projects config via initializationOptions and didChangeConfiguration"`

### Task 3: Grouped External Libraries tree

**Files:**
- Modify: `src/externalLibraries.ts`, `src/test/externalLibraries.test.ts`

- [x] **Step 1: Write failing tests**
  With a fake `sendRequest` serving `clojurePulse/projects`: root-level children are project nodes in server order; a project node's label/description reflect path, kind, status (including `error` tooltip message); project children are its libraries rendered as existing `library` nodes; when `clojurePulse/projects` rejects with **method-not-found (JSON-RPC `-32601`) only**, root-level children equal today's flat `externalLibraries` behavior; any other rejection renders an empty tree and logs the error (never stale flat data from a compatible server). Existing tests keep passing unmodified where possible.

- [x] **Step 2: Run to verify failure**
  Run: `make test`
  Expected: FAIL on new cases.

- [x] **Step 3: Implement**
  Add a `project` variant to `LibNode`; `getChildren(undefined)` tries `clojurePulse/projects` once per refresh (cache the promise, generation-guarded like `jarEntries`), with the method-not-found-only fallback above. `getTreeItem` for projects: `contextValue` encodes the toggle state — `"clojurePulseProjectEnabled"` / `"clojurePulseProjectDisabled"` (contributed command icons are static, so state-dependent inline actions need distinct context values); status → description text, `resolving` uses a spinner ThemeIcon (`loading~spin`).

- [x] **Step 4: Run to verify pass**
  Run: `make test`
  Expected: PASS.

- [x] **Step 5: Commit**
  `git commit -m "feat: group external libraries by project"`

> Codex review (07752e9): one P2 — the method-not-found fallback evicted the root cache, re-requesting both methods on every repaint against old servers. Fixed in fd208e4: the fallback result now stays cached until `refresh()`; only retryable failures evict.

> Deviation: existing root-level tests' fakes only knew `externalLibraries`, so they were minimally wrapped (`flatServer`) to answer `clojurePulse/projects` with method-not-found — they now exercise the fallback path; assertions unchanged. Two UX calls the plan left open: the root project node renders Expanded (a single-project workspace reads like the old flat panel), and project nodes get a stable `TreeItem.id` so status changes don't collapse an expanded project.

### Task 4: Per-project toggle command

**Files:**
- Modify: `src/extension.ts`, `package.json`, `src/test/projects.test.ts`

- [x] **Step 1: Register the commands + menus**
  Two commands sharing one handler parameterized by direction: `clojurePulse.enableProjectClasspath` (icon e.g. `debug-start`) and `clojurePulse.disableProjectClasspath` (icon e.g. `debug-stop`), each taking the project node; both go through `withToggled` on the **raw** setting value and write workspace settings with the same target logic as `writeReplConfigurations`. `package.json`: both command declarations with icons; `view/item/context` contributions **twice per command** — an `inline` group entry and a plain context-menu entry (VS Code treats these as separate groups) — gated `when: viewItem == clojurePulseProjectDisabled` (enable) / `clojurePulseProjectEnabled` (disable). No direct tree mutation — the settings change → notification → `librariesChanged` → refresh loop is the only path.

- [x] **Step 2: Unit-test the write path**
  Test `withToggled` insert/update against representative existing settings arrays (already partly covered in Task 1 — extend for the command's read-modify-write flow if extracted as a helper).

- [x] **Step 3: Run + manual smoke**
  Run: `make check`
  Expected: PASS. F5 smoke: toggling a subproject flips it to `resolving…` then `resolved`, libraries appear under it.
  > Deviation: no interactive F5 host — the enable→resolving→resolved server round-trip was already proven by the Task 2 scripted LSP smoke; the toggle's own glue (node → `withToggled` → settings write) is covered by the new read-modify-write unit test. Also added `commandPalette` `"when": "false"` entries — the toggles are meaningless without a tree node.

- [x] **Step 4: Commit**
  `git commit -m "feat: per-project classpath resolution toggle"`

> Codex review (1ab52a6): two P2s, both fixed in 8719833 — `withToggled` now matches only parser-valid entries (an invalid same-path entry could swallow the toggle), and toggle writes are serialized through a promise chain (two quick clicks could clobber each other). Fix re-reviewed by codex (round 2).

### Task 5: Docs

**Files:**
- Modify: `README.md`

- [x] **Step 1: Document monorepo support** (use /writing-clearly)
  New "Monorepos" section: what is automatic (detection, source indexing, `.cpcache`), what the toggle does (JVM classpath command), the `clojurePulse.projects` setting with an example, the note that `create` REPLs use `cwd` for subprojects (existing feature, cross-reference).
  > Deviation: kept em-dashes in the new section despite writing-clearly's ban — the README's established style uses them throughout, and document-internal consistency is the value that rule protects. Also added a settings-table row and a one-line cross-reference in the External Libraries feature bullet.

- [x] **Step 2: Final gate**
  Run: `make check`
  Expected: PASS.

- [x] **Step 3: Commit**
  `git commit -m "docs: monorepo projects configuration"`

---

## Completion Summary

**Implemented** (commits 6cbcb5d..c25b4e0 on `monorepo`):
- `clojurePulse.projects` setting (resource scope) with schema, snippets, and a pure model in `src/projects.ts`: `parseProjects` (skip-with-warning, mirroring REPL configs), `toServerConfig` (flat keys → nested `{classpath: {enabled, cmd}}`), `withToggled` (raw-value rewrite preserving invalid entries and unknown keys), `normalizeProjectPath` (matches the server: `\`→`/`, `./`/trailing-slash/whitespace stripped, workspace-relative enforced).
- Both config channels: `initializationOptions` at client start; explicit `DidChangeConfigurationNotification` push (`{settings: {clojurePulse: {projects}}}`) on setting change, no restart.
- External Libraries tree grouped by project: one node per project (root labeled with the workspace folder name, `kind · status` description, `loading~spin` while resolving, error message in tooltip, contextValue `clojurePulseProjectEnabled/Disabled`), libraries as unchanged child nodes, `clojurePulse/projects` cached per refresh; flat-list fallback strictly on JSON-RPC `-32601`, any other failure renders empty + logs and retries next paint.
- Per-project toggle: `clojurePulse.enableProjectClasspath` / `disableProjectClasspath`, inline + context menus, writes settings only (server round-trip refreshes the tree); writes serialized against rapid clicks.
- README: "Monorepos" section, settings-table row, features cross-reference.

**Verification:** `make check` green at HEAD (lint, compile, 605 tests). End-to-end: scripted stdio LSP session driving the real multi-project `clj-pulse` (debug build) with the extension's exact payloads — initOptions override applied, live config push flipped a subproject to resolved without restart, `librariesChanged` observed.

**Codex review rounds (all findings fixed):**
- Task 1: backslash normalization + workspace-relative validation (c68dea5).
- Task 3: method-not-found fallback no longer evicts the root cache (fd208e4).
- Task 4: toggle matches only parser-valid entries; toggle writes serialized (8719833, re-reviewed clean).
- Task 5: config.edn location clarified to workspace root (c25b4e0).

**Deviations (gathered):**
- Session task-list tools unavailable in this build — the plan document was the single tracking surface.
- No interactive F5 host: both manual smokes replaced by the scripted LSP smoke (scratchpad `smoke.js`) + unit coverage of the extension-side glue. The one untested-in-anger surface is the VS Code UI wiring itself (menus/icons on real tree rows).
- Root project node renders Expanded; project nodes carry a stable `TreeItem.id`; toggle commands hidden from the command palette (`when: false`) — small UX calls the plan left open.
- Existing root-level provider tests wrapped in a `flatServer` helper so they exercise the fallback path; assertions unchanged.
- README section keeps the document's em-dash style despite writing-clearly's ban, for internal consistency.

**What the plan could have specified better:** whether the root project node defaults to expanded and how toggle commands behave from the command palette (both had to be decided during Task 3/4); and the manual-smoke steps could have named a scriptable fallback up front, since plan execution may be headless.
