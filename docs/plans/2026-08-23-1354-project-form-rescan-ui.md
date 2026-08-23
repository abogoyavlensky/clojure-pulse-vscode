# Project Edit Form, Rescan Wiring, and View Progress Implementation Plan

> **For agentic workers:** Use executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **STATUS: COMPLETED** (2026-08-23) — all 5 tasks implemented, reviewed, and verified end-to-end. See the completion summary at the end.

**Goal:** A webview form for adding/editing per-project classpath overrides (view-title `+`, inline pencil), a refresh button that triggers a real server rescan with visible progress on the view, and docs for the reset-by-deleting-the-setting path.

**Tech Stack:** TypeScript, VS Code extension API, vscode-languageclient 9.x.

**Depends on:** clj-pulse's `clojurePulse/rescan` and `$/progress` (its plan: `clj-pulse/docs/plans/2026-08-23-1354-own-paths-filter-rescan-progress.md`). Every feature here degrades gracefully without it: the form is settings-only, refresh falls back to a plain repaint on method-not-found, and view progress simply never opens if no project reports `resolving`.

---

## Design

### Context

The monorepo work (plan `2026-08-23-0158-projects-panel-monorepo.md`, completed) added the `clojurePulse.projects` setting, the project-grouped External Libraries tree, and an inline enable/disable toggle. Settled follow-up decisions from the design discussion:

- Keep the inline play/stop toggle as the fast path; add a pencil for the full edit.
- One ungated **"Remove from settings"** action — no detected-vs-configured gating (that would need a new server contract field). The layering makes it correct for free: removing the entry for a settings-added project drops the project; for a detected project it just reverts to defaults and the row stays.
- No reset button, no completion toasts. Full reset = delete the setting (applies live via the existing `didChangeConfiguration` push) — documented, not buttoned.
- Settings remain the single source of truth; the panel follows via the existing settings → notification → `librariesChanged` → refresh loop. The form writes only the editor-settings override layer.

### Pure rules (`src/projects.ts`)

Mirror `src/repl/replConfigEdit.ts`'s exports, generalizing `withToggled`'s matching rule (first *parser-valid* entry with the normalized path; invalid and unknown entries preserved verbatim):

- `upsertProjectEntry(raw: unknown[], path: string, changes: {classpathEnabled?: boolean; classpathCommand?: string})` — merges `changes` into the first valid matching entry or appends `{path: <normalized>, ...changes}`. A key set to `undefined` in `changes` is **removed** from the entry (that's how the form clears a command override — possible in the editor layer, unlike `config.edn` keys). Never mutates input.
- `removeProjectEntry(raw: unknown[], path: string): unknown[]` — removes the first valid matching entry; everything else preserved verbatim.
- `projectFormValuesFor(node: {path, kind, enabled, cmd}, rawEntry: unknown): ProjectFormValues` — effective values for the form: checkbox from the node's effective `enabled`, command field from the raw entry's `classpathCommand` if present else empty, plus `hasEntry: boolean`. **Placeholder rule (one rule, everywhere):** the placeholder is the node's effective `cmd` when the server provided one (that is the per-kind default when nothing overrides it, and the `config.edn` value when the file layer set one), falling back to the per-kind default string when absent.
- `validateProjectForm(values, existingPaths: string[], mode: "add" | "edit")` — add mode validates the path with the same rules as `parseProjects` (non-empty, workspace-relative after normalization) and rejects a duplicate of an existing project path.

`withToggled` stays (the inline toggle keeps using it); its find-first-valid-match helper is shared with the new functions.

### Form panel (`src/projectFormPanel.ts`)

Pattern of `ReplFormPanel` / `CustomCommandFormPanel`: a dumb webview renderer over the pure rules, with injected `createPanel`, `readEntries` (raw `clojurePulse.projects`, for pre-filling), `updateEntries(update: (raw: unknown[]) => unknown[]): Promise<void>` (for all writes — see the serialization note below), and `confirmRemove`. Modes:

- **Add** (`open({kind: "add"})`): editable path field, enabled checkbox (default on — adding a project usually means wanting its classpath), command field with per-kind hint unavailable (kind unknown pre-detection; use the generic deps default `clojure -A:dev:test -Spath` as placeholder).
- **Edit** (`open({kind: "edit", project: {path, kind, enabled, cmd}})`): path read-only; enabled checkbox from effective state; command field placeholder per the placeholder rule above (node's effective cmd, else the per-kind default — deps → `clojure -A:dev:test -Spath`, lein → `lein classpath`); for `lgx`, the command field is disabled with a note that lgx resolves dependencies internally.
- A hint line in both modes: entries here are workspace-settings overrides; values set in `.clj-pulse/config.edn` can be overridden but not unset from here.
- **Remove from settings** button, shown only when `hasEntry` (a raw entry exists for the path), behind a modal confirm. Label exactly "Remove from settings".
- Save: build `changes` (always explicit `classpathEnabled` from the checkbox; `classpathCommand` from a non-empty field, `undefined` to remove when blanked) → `updateEntries((raw) => upsertProjectEntry(raw, path, changes))`; Remove → `updateEntries((raw) => removeProjectEntry(raw, path))`. The tree updates through the server round-trip; the panel never mutates tree state.
- **Write serialization:** the panel never computes the replacement array from a pre-read snapshot. The whole read-modify-write runs inside the mutation function, which the extension executes inside `projectsWriteChain` (reading the raw setting *within* the chained thunk) — so a toggle landing between the form's open and its save cannot be overwritten by a stale array.

### Commands, menums, wiring

- `clojurePulse.addProject` — view-title `navigation` button (`$(add)`) on the External Libraries view, next to refresh; opens the form in add mode. Palette-visible is fine for this one (it needs no node), matching `addReplConfig`.
- `clojurePulse.editProject` (`$(edit)`) — `view/item/context` at `inline@2` for both `clojurePulseProjectEnabled` and `clojurePulseProjectDisabled`, plus a plain context-menu entry; palette-hidden (`commandPalette` `when: "false"`). Handler extracts `{path, kind, enabled, cmd}` from the project node (same guard shape as `projectPathOf`) and opens edit mode. Existing toggle stays at `inline@1`.
- Write target logic identical to the toggle's (`Workspace` when a folder is open, else `Global`), and writes go through the existing `projectsWriteChain` so the form and toggle can't interleave.

### Refresh → rescan, view progress

- The refresh button's handler becomes: if a client is running, `client.sendRequest("clojurePulse/rescan", {})`; on rejection with JSON-RPC code `-32601` (older server) or with no client, fall back to `externalLibraries.refresh()` exactly as today. On success, no local refresh call — the server's `librariesChanged` (fired when statuses flip to `resolving`) drives the repaint.
- View progress: `ExternalLibrariesProvider` gains an injected optional callback `onRootStatuses(anyResolving: boolean)`, invoked when a `requestRoot` **settles, success or failure**: `true` only when a successful grouped response has some project with `classpath.status === "resolving"`; `false` for a grouped response without one, for the flat fallback, and for a failed root load (a failure must close progress, never strand it). Callbacks are **generation-guarded** like the provider's caches: a request that settles after a `refresh()` superseded it reports nothing, so out-of-order responses cannot re-open or wrongly close progress. In `extension.ts`, a small single-flight controller: when `anyResolving` first turns true, open `vscode.window.withProgress({location: {viewId: "clojurePulse.externalLibraries"}, title: "Resolving classpath…"}, () => deferred.promise)`; resolve the deferred when a later callback reports `false` (or on client stop). Driven by tree state, not by the rescan call — so startup and config-change resolutions show it too.

### Testing

House style: pure-rule unit tests in `src/test/projects.test.ts`; panel tests mirroring `replFormPanel.test.ts` (fake panel, injected read/write); provider callback and rescan-fallback tests in `src/test/externalLibraries.test.ts` / extension-level tests where they fit. `make check` gates every task. No interactive-host steps: the server half is covered by the clj-pulse plan's e2e; note any F5-only surface in the completion summary instead.

## File Structure

- Modify: `src/projects.ts` — `upsertProjectEntry`, `removeProjectEntry`, `projectFormValuesFor`, `validateProjectForm` (+ shared match helper).
- Create: `src/projectFormPanel.ts` — the webview form (dumb renderer, injected deps).
- Create: `src/test/projectFormPanel.test.ts`
- Modify: `src/test/projects.test.ts` — new pure-rule tests.
- Modify: `src/externalLibraries.ts` — `onRootStatuses` callback.
- Modify: `src/test/externalLibraries.test.ts` — callback cases.
- Modify: `src/extension.ts` — command registration, rescan-on-refresh, progress controller, form wiring.
- Modify: `package.json` — two commands, view-title button, menus, palette hiding.
- Modify: `README.md` — form/pencil/`+`, refresh-rescans, reset note.

---

### Task 1: Pure rules in `projects.ts`

**Files:**
- Modify: `src/projects.ts`, `src/test/projects.test.ts`

- [x] **Step 1: Write failing tests**
  `upsertProjectEntry`: merge into first valid match (invalid same-path entries skipped, unknown keys preserved); append with normalized path when no match; `undefined` in `changes` removes that key; never mutates. `removeProjectEntry`: removes first valid match only; preserves invalid entries; no-op array copy when nothing matches. `projectFormValuesFor`: raw-entry cmd wins the field, node cmd is placeholder-only; `hasEntry` reflects a valid raw entry. `validateProjectForm`: add-mode path rules match `parseProjects` (empty, absolute, `..`, duplicate → errors); edit mode skips path validation.

- [x] **Step 2: Run to verify failure**
  Run: `make test`
  Expected: FAIL on the new cases.

- [x] **Step 3: Implement**
  Extract `withToggled`'s find-first-valid-match into a shared helper; implement the four functions per the design (pin the `changes` shape: `{classpathEnabled?: boolean; classpathCommand?: string}` where an explicitly-passed `undefined` deletes the key — distinguish via `"classpathCommand" in changes`).

- [x] **Step 4: Run to verify pass**
  Run: `make test`
  Expected: PASS.

- [x] **Step 5: Commit**
  `git commit -m "feat: project entry edit rules"`

> Deviation: `projectFormValuesFor` takes the whole raw settings array (not a pre-found `rawEntry`) so the first-valid-match rule stays in one place instead of being duplicated by callers; `withToggled` became a thin wrapper over `upsertProjectEntry`.

### Task 2: Form panel

**Files:**
- Create: `src/projectFormPanel.ts`, `src/test/projectFormPanel.test.ts`

- [x] **Step 1: Write failing tests**
  Mirroring `replFormPanel.test.ts`'s fakes: add mode saves a new entry via `updateEntries` (explicit `classpathEnabled`, cmd omitted when blank); the mutation function is applied to whatever array `updateEntries`'s fake supplies at call time — a test proves an entry toggled *after* the form opened survives the form's save (the stale-snapshot case); edit mode pre-fills from node + raw entry (placeholder rule: node cmd, else per-kind default) and path is read-only; blanking a previously-set command removes the key; lgx edit renders the command field disabled; Remove button only when `hasEntry`, calls `confirmRemove` then removes the entry via `updateEntries`; validation errors render and block save.

- [x] **Step 2: Run to verify failure**
  Run: `make test`
  Expected: FAIL.

- [x] **Step 3: Implement**
  `ProjectFormPanel` per the design — copy `CustomCommandFormPanel`'s structure (it is the smaller template), webview HTML with the three fields, the override hint line, and per-kind placeholders.

- [x] **Step 4: Run to verify pass**
  Run: `make test`
  Expected: PASS.

- [x] **Step 5: Commit**
  `git commit -m "feat: project override form panel"`

> Deviation: add-mode duplicate validation checks against valid raw settings entries (`validSettingsPaths`, new helper), not against detected projects — adding an override for an already-detected project via `+` is legitimate, and a concurrent duplicate is harmless because `upsertProjectEntry` merges instead of appending. A `settled()` test hook exposes the panel's internal write queue for message-driven saves.

### Task 3: Commands, menus, wiring

**Files:**
- Modify: `src/extension.ts`, `package.json`

- [x] **Step 1: Wire commands + contributions**
  Register `clojurePulse.addProject` and `clojurePulse.editProject`; instantiate the panel with `readEntries: rawProjects` and `updateEntries` implemented as a `projectsWriteChain`-chained thunk that reads `rawProjects()` *inside* the chain, applies the mutation, and writes with the toggle's target logic — refactor `toggleProjectClasspath` to share this helper so both paths serialize through one place. `package.json`: command declarations (`$(add)`, `$(edit)`), view-title navigation entry for add on `clojurePulse.externalLibraries`, `view/item/context` pencil at `inline@2` for both project context values plus a context-menu group entry, `commandPalette` hiding for `editProject`.

- [x] **Step 2: Run the suite**
  Run: `make check`
  Expected: PASS.

- [x] **Step 3: Commit**
  `git commit -m "feat: add/edit project commands and menus"`

### Task 4: Rescan on refresh + view progress

**Files:**
- Modify: `src/externalLibraries.ts`, `src/extension.ts`, `src/test/externalLibraries.test.ts`

- [x] **Step 1: Write failing tests**
  Provider: `onRootStatuses` fires `true` when any project's status is `resolving`; `false` for a grouped response with none, for the flat fallback, **and for a failed root load**; a request superseded by `refresh()` before settling reports nothing (generation guard — cover the out-of-order case: old request resolves `true` after the new one already reported `false`). Extension-level (pure part): the refresh handler's fallback logic — extract a testable `rescanOrRefresh(sendRequest, refresh)` helper if needed: `-32601` → refresh called; success → refresh not called; other errors → logged, refresh called (a broken rescan must not leave a dead button).

- [x] **Step 2: Run to verify failure**
  Run: `make test`
  Expected: FAIL.

- [x] **Step 3: Implement**
  Provider callback; refresh command rewired to `rescanOrRefresh`; single-flight `withProgress` controller in `extension.ts` (open on first `true`, resolve deferred on `false` or client stop).

- [x] **Step 4: Run to verify pass**
  Run: `make check`
  Expected: PASS.

- [x] **Step 5: Commit**
  `git commit -m "feat: refresh triggers server rescan with view progress"`

> Codex review (aee6633): two P2s on the progress controller, both fixed in e251556 — the session is now reserved synchronously via an `open` flag (a `false` arriving before `withProgress`'s callback installed the resolver was silently lost, stranding the bar), and a client transition to `Stopped` closes the bar (a crashed server can never report "done"). Fix re-reviewed (round 2), which found a third race — a close-then-reopen before the first callback ran could cross-wire two sessions' resolvers through the shared flag; fixed in 6430707 with per-session identity (each callback closes over its own session object). Round 3 clean.

> Deviation: `rescanOrRefresh` lives in `externalLibraries.ts` (it uses the `SendRequest` type and the shared method-not-found constant) rather than `extension.ts`, keeping the vscode-free logic unit-testable.

### Task 5: Docs

**Files:**
- Modify: `README.md`

- [x] **Step 1: Update the Monorepos section** (use /writing-clearly)
  Add: the `+`/pencil form (what it edits — workspace-settings overrides), refresh now re-detects and re-resolves (older servers: repaint only), and the reset note: remove the `clojurePulse.projects` setting to return to auto-detected defaults — applies live, no restart; a root `.clj-pulse/config.edn` keeps its own say.

- [x] **Step 2: Final gate**
  Run: `make check`
  Expected: PASS.

- [x] **Step 3: Commit**
  `git commit -m "docs: project form, rescan, and reset notes"`

---

## Completion Summary

**Implemented** (commits 2819cf0..d24826c on `monorepo`):
- Pure edit rules in `src/projects.ts`: `upsertProjectEntry` (explicit-`undefined` deletes a key), `removeProjectEntry`, `projectFormValuesFor` (override in the field, effective cmd as placeholder), `validateProjectForm`, `validSettingsPaths`; `withToggled` became a thin wrapper over the upsert.
- `src/projectFormPanel.ts`: webview form on the `CustomCommandFormPanel` pattern — add mode (editable path) and edit mode (read-only path, per-kind placeholder, lgx cmd disabled, override hint), "Remove from settings" gated on an existing entry, all writes through an injected `updateEntries(update)` mutation so the read-modify-write runs inside the extension's serialized chain.
- Commands/menus: `clojurePulse.addProject` (view-title `+`), `clojurePulse.editProject` (inline pencil at `inline@2` + context menu, palette-hidden); `updateProjects` is now the single serialized write path shared by toggle and form.
- Refresh button → `rescanOrRefresh`: `clojurePulse/rescan` on capable servers (server notifications repaint), plain repaint on `-32601` or when no client, log + repaint on other errors.
- View progress: provider `onRootStatuses` callback (fires on every root-load settle, `false` on fallback/failure, generation-guarded) drives a single-flight `withProgress` bar on the view, with per-session identity and closure on client stop.
- README: progress/rescan behavior, form entry points, reset-by-deleting-the-setting note.

**Verification:** `make check` green at HEAD (lint, compile, 639 tests, up from 605). End-to-end: scripted stdio LSP session against the real Plan-A clj-pulse debug build — startup resolution emitted `$/progress` with per-run tokens, the own-dirs filter held (no `src` pseudo-library), and `clojurePulse/rescan` (the refresh button's exact call) returned null immediately, re-resolved with fresh tokens, and fired `librariesChanged`.

**Codex review rounds (all findings fixed):**
- Tasks 1–3: clean.
- Task 4: three rounds on the progress controller — lost-close race before the callback installed its resolver, no closure on server crash (aee6633 → e251556), then cross-wired sessions on close-reopen (→ 6430707, per-session identity). Round 3 clean.
- Task 5: docs overpromised gitignored-subproject discovery via rescan; qualified in d24826c (detection honors `.gitignore` — a listed entry is the prerequisite).

**Deviations (gathered):**
- `projectFormValuesFor` takes the raw settings array, not a pre-found entry (keeps the first-valid-match rule in one place).
- Add-mode duplicate validation checks valid raw settings entries, not detected projects — adding an override for a detected project via `+` is legitimate.
- `rescanOrRefresh` lives in `externalLibraries.ts` (shares `SendRequest` and the `-32601` constant), not `extension.ts`.
- A `settled()` test hook on the panel exposes its write queue for message-driven saves.
- Session task-list tools unavailable in this build — the plan document was the single tracking surface. No interactive F5 host; the UI wiring (menu placement, form rendering in a real webview) is the one surface verified only by contribution schema + unit-level fakes.

**What the plan could have specified better:** the progress controller deserved its own unit-tested seam — three review rounds of async races (lost close, crash, session cross-wiring) all lived in the one vscode-bound function the plan left untested; extracting a pure state machine would have caught them in tests.
