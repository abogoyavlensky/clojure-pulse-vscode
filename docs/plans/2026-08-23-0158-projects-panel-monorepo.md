# Projects Panel & Monorepo Config Implementation Plan

> **For agentic workers:** Use executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

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

- [ ] **Step 1: Write failing tests**
  For three functions:
  - `parseProjects(raw: unknown)` — returns valid entries **and** the skip reasons, following the exact error-reporting shape `parseReplConfigurations` uses (`src/repl/replConfig.ts`), so the caller logs them to the output channel; never silently drops.
  - `toServerConfig(entries: ProjectSetting[]): {projects: ...}` — flat keys → nested `classpath` shape; omitted keys omitted, not defaulted (the server owns defaults).
  - `withToggled(raw: unknown[], path: string, enabled: boolean): unknown[]` — operates on the **raw** setting value, preserving invalid/unrecognized entries and unknown keys verbatim; only the entry matching `path` is updated (or a minimal `{path, classpathEnabled}` entry inserted). Path matching normalizes `./foo` vs `foo`, trailing slashes, and whitespace; a duplicate-path entry updates the first match. Once set, `classpathEnabled` stays explicit — no removal when it happens to equal the server default.

- [ ] **Step 2: Run to verify failure**
  Run: `make test`
  Expected: FAIL on the new file.

- [ ] **Step 3: Implement + declare the setting**
  `package.json` `contributes.configuration`: `clojurePulse.projects`, `scope: "resource"`, array of objects with `path` (required string), `classpathEnabled` (boolean), `classpathCommand` (string); description notes paths are workspace-root-relative and entries override server auto-detection — or **add** a project detection missed (e.g. a subproject under a gitignored directory).

- [ ] **Step 4: Run to verify pass**
  Run: `make test`
  Expected: PASS.

- [ ] **Step 5: Commit**
  `git commit -m "feat: clojurePulse.projects setting and mapping"`

### Task 2: initializationOptions + live config push

**Files:**
- Modify: `src/client.ts`, `src/extension.ts`

- [ ] **Step 1: Wire both channels**
  `createClient` accepts the mapped server config and sets `clientOptions.initializationOptions`. In `extension.ts`, read + map the setting at `start()`; extend the existing `onDidChangeConfiguration` handler: when `clojurePulse.projects` changes and a client is running, `client.sendNotification(DidChangeConfigurationNotification.type, { settings: { clojurePulse: toServerConfig(...) } })`. (Import the notification type from `vscode-languageclient`.)

- [ ] **Step 2: Manual smoke via extension host**
  F5 host on a monorepo fixture with a multi-project clj-pulse build: server log shows the initOptions-provided overrides; editing the setting logs a config reload without restart.

- [ ] **Step 3: Run the suite**
  Run: `make check`
  Expected: PASS.

- [ ] **Step 4: Commit**
  `git commit -m "feat: forward projects config via initializationOptions and didChangeConfiguration"`

### Task 3: Grouped External Libraries tree

**Files:**
- Modify: `src/externalLibraries.ts`, `src/test/externalLibraries.test.ts`

- [ ] **Step 1: Write failing tests**
  With a fake `sendRequest` serving `clojurePulse/projects`: root-level children are project nodes in server order; a project node's label/description reflect path, kind, status (including `error` tooltip message); project children are its libraries rendered as existing `library` nodes; when `clojurePulse/projects` rejects with **method-not-found (JSON-RPC `-32601`) only**, root-level children equal today's flat `externalLibraries` behavior; any other rejection renders an empty tree and logs the error (never stale flat data from a compatible server). Existing tests keep passing unmodified where possible.

- [ ] **Step 2: Run to verify failure**
  Run: `make test`
  Expected: FAIL on new cases.

- [ ] **Step 3: Implement**
  Add a `project` variant to `LibNode`; `getChildren(undefined)` tries `clojurePulse/projects` once per refresh (cache the promise, generation-guarded like `jarEntries`), with the method-not-found-only fallback above. `getTreeItem` for projects: `contextValue` encodes the toggle state — `"clojurePulseProjectEnabled"` / `"clojurePulseProjectDisabled"` (contributed command icons are static, so state-dependent inline actions need distinct context values); status → description text, `resolving` uses a spinner ThemeIcon (`loading~spin`).

- [ ] **Step 4: Run to verify pass**
  Run: `make test`
  Expected: PASS.

- [ ] **Step 5: Commit**
  `git commit -m "feat: group external libraries by project"`

### Task 4: Per-project toggle command

**Files:**
- Modify: `src/extension.ts`, `package.json`, `src/test/projects.test.ts`

- [ ] **Step 1: Register the commands + menus**
  Two commands sharing one handler parameterized by direction: `clojurePulse.enableProjectClasspath` (icon e.g. `debug-start`) and `clojurePulse.disableProjectClasspath` (icon e.g. `debug-stop`), each taking the project node; both go through `withToggled` on the **raw** setting value and write workspace settings with the same target logic as `writeReplConfigurations`. `package.json`: both command declarations with icons; `view/item/context` contributions **twice per command** — an `inline` group entry and a plain context-menu entry (VS Code treats these as separate groups) — gated `when: viewItem == clojurePulseProjectDisabled` (enable) / `clojurePulseProjectEnabled` (disable). No direct tree mutation — the settings change → notification → `librariesChanged` → refresh loop is the only path.

- [ ] **Step 2: Unit-test the write path**
  Test `withToggled` insert/update against representative existing settings arrays (already partly covered in Task 1 — extend for the command's read-modify-write flow if extracted as a helper).

- [ ] **Step 3: Run + manual smoke**
  Run: `make check`
  Expected: PASS. F5 smoke: toggling a subproject flips it to `resolving…` then `resolved`, libraries appear under it.

- [ ] **Step 4: Commit**
  `git commit -m "feat: per-project classpath resolution toggle"`

### Task 5: Docs

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Document monorepo support** (use /writing-clearly)
  New "Monorepos" section: what is automatic (detection, source indexing, `.cpcache`), what the toggle does (JVM classpath command), the `clojurePulse.projects` setting with an example, the note that `create` REPLs use `cwd` for subprojects (existing feature, cross-reference).

- [ ] **Step 2: Final gate**
  Run: `make check`
  Expected: PASS.

- [ ] **Step 3: Commit**
  `git commit -m "docs: monorepo projects configuration"`
