# REPL Configuration Form Implementation Plan

> **For agentic workers:** Use executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the sidebar the one place REPLs are managed: a form for adding and editing configurations, an inline Edit action on every row, Delete from the form, and no unsaved ad-hoc connections.

**Tech Stack:** TypeScript (VS Code extension: `WebviewViewProvider`, context keys, workspace settings), no new dependencies.

---

## Design

### The problem

Adding a REPL is a four-step quick-pick sequence with no way back, and the long
`create` command has to be edited in a one-line input box. Editing is worse:
`clojurePulse.editReplConfig` runs `workbench.action.openWorkspaceSettingsFile`
and leaves you to find the entry in `settings.json` yourself.

### Approach

One UI for both. A new **webview view** in the existing `clojurePulseSidebar`
container renders a form with every field visible at once — including a
multi-line box for the command. The commands that used to prompt now open it.

The view is declared with `"when": "clojurePulse.replFormOpen"`, so it exists
only while a form is open; the rest of the time the REPL tree and External
Libraries have the sidebar to themselves. The form sits **below** the REPL tree:
VS Code cannot interleave content between tree rows, so a form under the edited
row is not reachable without giving up the native tree — which would cost the
built-in row icons, hover actions, keyboard navigation, and empty-state welcome.
Keeping the tree is the deliberate trade.

```
∨ REPL                          +
   ▶  ✎   dev        stopped
   ⏹  ✎   local      connected :7888

∨ EDIT "local"
   Type  ( ) Start a REPL
         (•) Connect to a running REPL
   Name  [ local                    ]
   Host  [ localhost                ]
   Port  [ .nrepl-port              ]

   [ Delete ]        [ Cancel ] [ Save ]

∨ EXTERNAL LIBRARIES
```

The webview is a dumb renderer, the same shape the deleted `replPanel.ts` used
(recover its CSP/nonce/message pattern with `git show d026c75^:src/repl/replPanel.ts`):
it posts `ready` on load and the host replies with what to show. All rules —
defaults, validation, how an entry is written back — live in a pure module with
no `vscode` import, so both the form and any other caller share one
implementation and the rules stay unit-testable. This matches the existing
split in `src/repl/` (`replConfig.ts`, `replTree.ts`, `outputRenderer.ts` are
pure; the wiring in `extension.ts` is thin).

### One UI, not two

`addReplConfig` and `editReplConfig` both open the form. The prompt helpers
(`promptCreateEntry`, `promptConnectEntry`, and the type/name quick-picks inside
`addReplConfig`) are deleted rather than kept as a second path — two ways to
enter the same data means two things to keep in sync, and the sidebar is always
available.

The ad-hoc *"Connect to host:port…"* flow in `connectRepl` goes too, in Tasks 4
and 5 — see *Retiring ad-hoc sessions* below. Tasks 1–3 leave it alone, so the
form can ship on its own.

### Form model

Form values are all strings — that is what an HTML form carries, and keeping the
conversion in one place is what makes the rules testable:

```ts
interface ReplFormValues {
  name: string;
  type: "create" | "connect";
  command: string;   // create
  cwd: string;       // create
  host: string;      // connect
  port: string;      // connect
}
```

Both field sets are kept in the model while the form is open, so switching the
type selector back and forth does not lose what was typed. Only the fields
belonging to the chosen type are written.

- **Adding:** `name` empty, `type` `"create"`, `command` prefilled from
  `defaultCreateCommand()`, `cwd` `"."`, `host` `"localhost"`, `port`
  `".nrepl-port"`.
- **Editing:** filled from the raw settings entry, falling back to the same
  defaults for anything absent.

### Writing back

Save is a read-modify-write of the **raw, unfiltered**
`clojurePulse.replConfigurations` array. Unfiltered matters: the existing
`currentReplConfigurations()` drops non-object entries, so writing back through
it would silently delete a stray scalar the parser merely warns about. The form
reads the setting value as-is and preserves every entry it did not touch —
`configEntryName()` returns nothing for a scalar, so those are never matched and
simply survive.

- The edited entry is found by its **original** name, compared through
  `configEntryName()` so a hand-edited `{"name": " dev "}` matches the `dev` row
  the tree shows. If it has vanished (settings edited meanwhile), the entry is
  appended instead.
- Unknown keys on the original entry are preserved; keys belonging to the *other*
  type are dropped, so switching `create` → `connect` removes `command`/`cwd`.
- Values equal to their default are omitted — no `"cwd": "."`, no
  `"host": "localhost"` — matching the compact style documented in the README.
- A numeric `port` is written as a number; anything else as a string path.

The settings **target** follows the workspace: `ConfigurationTarget.Workspace`
when a folder is open, `Global` (user settings) when one is not. Writing to the
workspace is what makes configurations travel with the project; falling back to
user settings is what makes the feature usable at all in a single-file window,
which is the only situation the removed ad-hoc flow uniquely served.

Validation runs in the host, using the rules the parser already applies, and
returns a per-field message map:

- `name` — required, and not already taken by another *parseable* entry
  (`parseReplConfigurations(...).configs`, so a broken entry cannot block a name);
  when editing, the entry's own name is not a conflict with itself.
- `command` — required for `create`.
- `port` — `validatePortInput` from `replConfig.ts` (a number must be 1–65535;
  anything else is taken as a port-file path).

Errors are posted back to the webview and shown next to their fields. Nothing is
written until the form validates. A failure from the write itself — an
unwritable settings file, say — comes back in a general `form` slot shown above
the buttons, so the user keeps what they typed and can retry.

### Deleting

The edit form carries a third button, **Delete**, set apart from Cancel and
Save. Deleting is rare enough that it does not deserve a fourth inline icon on
the row — a running REPL already shows set-active and stop, the new pencil makes
three, and in a ~300px sidebar a fourth would start truncating names. The form
is where you are already looking at the configuration you mean to remove. The
existing right-click **Delete REPL Configuration** stays as the fast path, and
both routes share the same modal confirmation and the same `removeEntry` call.

### Row actions

`clojurePulse.editReplConfig` moves from the row's right-click menu to an
**inline** pencil icon, so Edit is visible next to Start/Stop without hunting
through a context menu. It stays in the context menu too, for discoverability.
Ad-hoc rows (`viewItem == replAdHoc`) have no configuration to edit and keep no
pencil. Clicking the row still opens that REPL's output channel — no icon needed
for it.

Hiding the pencil is not enough on its own: the palette and any keybinding reach
`editReplConfig` directly, so it excludes ad-hoc sessions everywhere — they are
filtered out of its quick pick, and a name that resolves to one is refused with a
message rather than opening a form that would append a stray entry. This is the
same rule `deleteReplConfig` already applies. Tasks 4 and 5 remove ad-hoc
sessions altogether and this guard goes with them; it is written anyway so that
every commit in between is correct on its own.

### Retiring ad-hoc sessions

Today `connectRepl` can attach to a `host:port` without saving anything, giving
a transient session that lives in the tree until it disconnects. That second
kind of session is the most intricate code in the registry — a session promoted
to a configured one when settings later claim its name, forgetting on stop, and
the interaction of both with the retirement path — and it exists to serve a case
the form now covers in a few seconds.

Removing it collapses the model to one sentence: **every row in the pane is a
configuration, and the pane is a projection of settings.** `addAdHoc`,
`isAdHoc`, `adHocNames`, `forget()`, and the `replAdHoc` context value all go;
`ReplTreeSource` loses a member and `presentSession`'s options shrink to
`isActive`. The user-settings fallback above covers the one case ad-hoc uniquely
served, so nothing is left stranded.

What changes for the user: `connectRepl` with no argument now quick-picks the
stopped `connect` configurations, and offers to add one when there are none.
A throwaway connection costs one form and one Delete instead of nothing — the
price of having a single concept.

### Behaviour worth knowing

- **No workspace folder:** the form opens and saves like anywhere else, into
  user settings. Nothing guards on the folder, which is also what lets the
  test host — which opens none — exercise the form at all.
- **Editing a running REPL:** the registry already defers a changed config until
  the session next stops (`ReplRegistry.setConfigs`), so a live REPL keeps the
  settings it launched with.
- **Renaming:** the registry sees one name gone and another added, so the old
  session and its output channel are disposed and a new pair appears.
- **A second Edit while the form is open:** the newest request wins; the host
  replaces the pending values and re-posts them.

### Testing

- `src/test/replConfigEdit.test.ts` — the pure core: defaults for add and edit,
  every validation rule, unknown-field preservation, wrong-type field removal,
  default omission, numeric-vs-path ports, upsert by original name, append when
  the entry is gone.
- `src/test/replFormView.test.ts` — the provider driven through a fake
  `WebviewView`: `ready` gets the pending values, `save` with valid values writes
  the expected array and closes, `save` with invalid values writes nothing and
  posts errors back, `delete` removes the entry after confirmation, `cancel`
  writes nothing and closes.
- Integration (`src/test/replManager.integration.test.ts`) — the commands open
  the form with the right mode and values, and Cancel closes it.
- Removing ad-hoc sessions is verified by subtraction: the registry and tree
  suites lose their ad-hoc cases, and `replCommands.integration.test.ts` moves
  from `addAdHoc` to configuration-driven setup — the pattern
  `replManager.integration.test.ts` already uses.

---

## File Structure

**Create:**
- `src/repl/replConfigEdit.ts` — pure form model: defaults, validation, entry
  building, upsert. No `vscode` import.
- `src/repl/replFormView.ts` — `ReplFormViewProvider implements vscode.WebviewViewProvider`:
  holds the pending form state, renders the HTML, translates messages into calls
  on injected callbacks.
- `src/test/replConfigEdit.test.ts`, `src/test/replFormView.test.ts`.

**Modify:**
- `package.json` — the `clojurePulse.replForm` view with its `when` clause; the
  inline pencil menu entry for `editReplConfig`; later, the `replAdHoc` context
  value drops out of four menu `when` clauses.
- `src/extension.ts` — register the provider; rework `addReplConfig` and
  `editReplConfig` to open the form; delete `promptCreateEntry`,
  `promptConnectEntry`, and the prompt body of `addReplConfig`; expose the form
  controller on `ExtensionApi`; later, drop `promptForAddress` and the ad-hoc
  entry from `connectRepl`.
- `src/repl/replRegistry.ts` — later, remove `addAdHoc`, `isAdHoc`,
  `adHocNames`, `forget()`, and the promotion rule in `setConfigs`.
- `src/repl/replTree.ts` — later, drop `isAdHoc` from `ReplTreeSource` and
  `presentSession`, and the `replAdHoc` context value.
- `src/repl/replStatusBar.ts` — later, `active.name` becomes required again.
- `src/repl/replConfig.ts` — later, drop `readNreplPort`, whose only caller was
  the ad-hoc prompt.
- `src/test/replManager.integration.test.ts` — form open/close coverage;
  `src/test/replCommands.integration.test.ts`, `replRegistry.test.ts`,
  `replTree.test.ts`, `replStatusBar.test.ts`, `replConfig.test.ts` — later,
  the ad-hoc migration.
- `README.md`, `CHANGELOG.md`.

---

### Task 1: Form model (`replConfigEdit.ts`)

**Files:**
- Create: `src/repl/replConfigEdit.ts`, `src/test/replConfigEdit.test.ts`

- [ ] **Step 1: Write failing tests**
  Cover every rule in the design's *Form model* and *Writing back* sections:
  `formValuesFor(undefined, defaultCommand)` returns the add defaults;
  `formValuesFor(entry, …)` fills from a `create` entry and from a `connect`
  entry, falling back to defaults for absent fields; `validateFormValues`
  rejects an empty name, a name taken by another parseable entry, an empty
  command for `create`, and a bad port, while accepting an entry's own name when
  editing it; `toConfigEntry` omits `cwd: "."` and `host: "localhost"`, writes a
  numeric port as a number and a path as a string, preserves unknown keys from
  the original entry, and drops the other type's keys when the type changed;
  `upsertEntry` replaces by original name (including a name that needed
  trimming), appends when the original is missing, appends for a new entry, and
  **leaves every entry it did not match untouched — including non-object ones**,
  so a stray scalar in the array survives an edit; `removeEntry` drops exactly
  the named entry and, likewise, leaves everything else in place.

- [ ] **Step 2: Run tests to verify they fail**
  Run: `make test`
  Expected: FAIL — cannot resolve `../repl/replConfigEdit`.

- [ ] **Step 3: Implement**
  Pure module, no `vscode` import. Reuse `configEntryName`, `validatePortInput`,
  and `parseReplConfigurations` from `replConfig.ts` rather than restating their
  rules. Pin these signatures — Tasks 2 and 3 call them:

  ```ts
  export interface ReplFormValues {
    name: string; type: "create" | "connect";
    command: string; cwd: string; host: string; port: string;
  }
  /** Per-field messages, plus `form` for a failure that belongs to no field. */
  export type ReplFormErrors = Partial<Record<keyof ReplFormValues, string>> & { form?: string };

  export function formValuesFor(entry: unknown | undefined, defaultCommand: string): ReplFormValues;
  export function validateFormValues(values: ReplFormValues, entries: unknown[], originalName?: string): ReplFormErrors;
  export function toConfigEntry(values: ReplFormValues, original?: unknown): Record<string, unknown>;
  export function upsertEntry(entries: unknown[], entry: Record<string, unknown>, originalName?: string): unknown[];
  /** Drops the entry with this name; everything else, matched or not, survives. */
  export function removeEntry(entries: unknown[], name: string): unknown[];
  ```

- [ ] **Step 4: Run tests to verify they pass**
  Run: `make test`
  Expected: PASS.

- [ ] **Step 5: Commit**
  `git commit -m "Add the REPL configuration form model"`

### Task 2: Form view (`replFormView.ts`)

**Files:**
- Create: `src/repl/replFormView.ts`, `src/test/replFormView.test.ts`

- [ ] **Step 1: Write failing tests**
  Drive the provider through a fake `WebviewView` — an object literal with a
  `webview` that records `postMessage` calls, captures the
  `onDidReceiveMessage` listener so the test can fire messages, and a stub
  `onDidDispose`. Inject `readEntries` (returning the raw array, scalars and
  all), `writeEntries`, `defaultCommand`, `confirmDelete`, and `onClose` so
  nothing touches settings. Cover: `open()` followed by resolve then
  a `ready` message posts the pending values and mode; a `save` with valid values
  calls `writeEntries` with the upserted array and then `onClose`; a `save` with
  an invalid name writes nothing and posts the field errors back with the values
  the user typed; a `save` whose `writeEntries` rejects
  keeps the form open and posts that message in the `form` error slot; a
  `delete` in edit mode calls the injected `confirmDelete`, writes the array
  without that entry when it resolves true, and writes nothing when it resolves
  false; `cancel` writes nothing and calls `onClose`; opening a second form
  while one is showing replaces the posted values. Pin the close lifecycle
  explicitly: after a successful save, a confirmed delete, and a cancel, `state`
  is cleared and `onClose` has run exactly once.

- [ ] **Step 2: Run tests to verify they fail**
  Run: `make test`
  Expected: FAIL — cannot resolve `../repl/replFormView`.

- [ ] **Step 3: Implement**
  `ReplFormViewProvider` with `static readonly viewId = "clojurePulse.replForm"`.
  Public surface: `open(mode)` where mode is `{ kind: "add" } | { kind: "edit"; name: string }`,
  `close()`, and `state` (the pending `{ mode, values }`, for tests and the
  extension API). Message protocol, shared with the HTML:

  ```ts
  // host → webview
  { type: "load"; mode: "add" | "edit"; title: string; values: ReplFormValues; errors: ReplFormErrors }
  // webview → host
  { type: "ready" } | { type: "save"; values: ReplFormValues } | { type: "cancel" } | { type: "delete" }
  ```

  Render the HTML with the CSP + nonce pattern from
  `git show d026c75^:src/repl/replPanel.ts`; style with `--vscode-*` variables so
  it matches the active theme (`input`, `button`, `focusBorder`,
  `inputValidation.errorBorder`, `descriptionForeground`). The type selector is
  two radios that show and hide the two field groups client-side without asking
  the host; both groups keep their values while hidden. The command is a
  `textarea` of about five rows — the whole reason for a form rather than an
  input box is that the default command runs to ~150 characters and wraps
  several times in a ~300px sidebar. Save posts the whole `ReplFormValues`.
  Delete renders only in edit mode, separated from Cancel and Save (`margin-right:
  auto`) so it cannot be hit by accident, and uses
  `--vscode-inputValidation-errorBorder` rather than a filled destructive
  colour. Set `view.title` from the pending mode (`Add REPL` or `Edit "<name>"`).
  Keep `retainContextWhenHidden` off — the host re-posts on `ready`.

- [ ] **Step 4: Run tests to verify they pass**
  Run: `make test`
  Expected: PASS.

- [ ] **Step 5: Commit**
  `git commit -m "Add the sidebar REPL configuration form view"`

### Task 3: Wiring — contributions, commands, row action

**Files:**
- Modify: `package.json`, `src/extension.ts`, `src/test/replManager.integration.test.ts`

- [ ] **Step 1: package.json contributions**
  Add `clojurePulse.replForm` to `contributes.views.clojurePulseSidebar`, with
  `"type": "webview"`, `"name": "REPL Configuration"`, and
  `"when": "clojurePulse.replFormOpen"`, positioned **after** the REPL tree and
  **before** External Libraries. Add an inline `view/item/context` entry for
  `clojurePulse.editReplConfig` — `"when": "view == clojurePulse.replManager && viewItem != replAdHoc"`,
  `"group": "inline@3"` — so the pencil follows the existing start/stop and
  set-active icons; leave the existing context-menu entry in place.

- [ ] **Step 2: Wire the provider and rework the commands**
  In `setupRepl`, construct `ReplFormViewProvider` with the real callbacks:
  `readEntries` → the **raw** `clojurePulse.replConfigurations` value (an array
  as-is, or `[]`), `writeEntries` → `config.update("replConfigurations", …)`
  against `ConfigurationTarget.Workspace` when `vscode.workspace.workspaceFolders`
  is non-empty and `Global` otherwise, `defaultCommand` → `defaultCreateCommand()`,
  `confirmDelete` → the modal warning `deleteReplConfig` already shows,
  `onClose` → clear the context key.
  Note that `currentReplConfigurations()` is *not* the reader here: it filters
  out non-object entries, which the form must preserve. While in this file,
  switch `deleteReplConfig` to the raw array too, so deleting one REPL no longer
  drops malformed entries the parser only warns about.
  Register it with `vscode.window.registerWebviewViewProvider`. Opening sets the
  context key (`vscode.commands.executeCommand("setContext", "clojurePulse.replFormOpen", true)`,
  the same mechanism `src/repl/inlineResults.ts:311` uses) and then focuses
  `clojurePulse.replForm.focus`, so the view resolves and asks for its values.
  Rework `addReplConfig` to open the form in add mode and nothing else — its
  workspace-folder guard goes away entirely, since a folderless window now saves
  to user settings. Rework `editReplConfig` to resolve a session name through the
  existing `sessionFor` helper (tree node, keybinding string, or quick pick) and
  open the form in edit mode — it no longer runs
  `workbench.action.openWorkspaceSettingsFile`. Its quick pick lists only
  non-ad-hoc sessions, and a name resolving to an ad-hoc session is refused with
  a message, exactly as `deleteReplConfig` does. Delete `promptCreateEntry`,
  `promptConnectEntry`, and the quick-pick body of `addReplConfig`. Add the
  provider to `ExtensionApi` as `replForm`.

- [ ] **Step 3: Update the integration tests**
  In `replManager.integration.test.ts`: `clojurePulse.addReplConfig` leaves the
  form in add mode with the default command prefilled;
  `clojurePulse.editReplConfig` with a configured name loads that entry's values
  in edit mode; a second edit replaces the pending values; `editReplConfig` on an
  ad-hoc session's name opens no form. Assert through `api.replForm.state`.
  The user-settings fallback also makes a full round trip testable for the first
  time: with no folder open the form writes to `Global`, which the suite already
  uses, so add a test that saving a new configuration makes its row appear in
  the registry — and reset the setting in `teardown`, as the existing tests do.

- [ ] **Step 4: Compile, lint, full test run**
  Run: `make check`
  Expected: PASS, and `grep -rn "promptCreateEntry\|promptConnectEntry" src` finds nothing.

- [ ] **Step 5: Check the form in a real window**
  Launch the extension host (F5) in a project with a `deps.edn`. Add a REPL from
  the **+** button, watch the form appear under the REPL list, save it, and
  confirm the row appears and starts. Press the pencil on that row, change the
  command, save, and confirm `settings.json` shows the edit with no
  `"cwd": "."` noise. Switch the type selector to `connect` and back to `create`,
  confirming the command you typed is still there — the webview's own field
  switching has no automated coverage, so this is where it gets checked. Save
  after switching to `connect` and confirm `command` is gone from the entry.
  Cancel a form and confirm the section disappears. Finally, put a stray
  `"junk"` string in the `replConfigurations` array by hand, edit a REPL through
  the form, and confirm the stray entry is still there afterwards.

- [ ] **Step 6: Commit**
  `git commit -m "Add and edit REPL configurations through the sidebar form"`

### Task 4: Drop the ad-hoc connect flow

Everything above ships without this task and the next; these two are where the
second kind of session goes away, leaving the pane a projection of settings and
nothing else. This one removes the only thing that *creates* an ad-hoc session,
which leaves the registry's ad-hoc API dead but harmless — so the suite stays
green and this task commits on its own.

**Files:**
- Modify: `src/extension.ts`, `package.json`,
  `src/test/replCommands.integration.test.ts`

- [ ] **Step 1: Migrate the integration tests**
  `replCommands.integration.test.ts` connects with `api.repls.addAdHoc(...)`.
  Replace its `connect()` helper with the configuration-driven setup from
  `replManager.integration.test.ts`: write a `connect` entry through
  `ConfigurationTarget.Global`, wait for the session to appear, start it by
  name, and reset the setting in `teardown`. Delete the "an ad-hoc session
  disappears when it disconnects" case — it describes a concept that is about to
  stop existing.

- [ ] **Step 2: Run tests to verify they pass**
  Run: `make test`
  Expected: PASS — the migrated tests exercise the same commands through a
  configuration instead of an unsaved session.

- [ ] **Step 3: Rework `connectRepl`**
  Delete `promptForAddress`, the "Connect to host:port…" quick-pick entry, and
  the `registry.addAdHoc(...)` call. Without an argument, `connectRepl` now
  quick-picks the stopped `connect` configurations; when there are none, it
  offers a single "Add a REPL configuration…" entry that runs `addReplConfig`
  rather than reporting a dead end. Drop the `readNreplPort` and
  `ReplConnectionInfo` imports if nothing else in the file uses them.

- [ ] **Step 4: package.json contributions**
  Drop `replAdHoc` from the two inline `=~` clauses (set-active and stop) and
  simplify the `viewItem != replAdHoc` clauses (show-output, edit, delete) to
  plain `view == clojurePulse.replManager`. Nothing can produce that context
  value once Step 3 lands.

- [ ] **Step 5: Compile, lint, full test run**
  Run: `make check`
  Expected: PASS.

- [ ] **Step 6: Commit**
  `git commit -m "Connect through saved configurations instead of ad-hoc sessions"`

### Task 5: Remove the ad-hoc machinery

**Files:**
- Modify: `src/repl/replRegistry.ts`, `src/repl/replTree.ts`,
  `src/repl/replStatusBar.ts`, `src/repl/replConfig.ts`, `src/extension.ts`
- Modify: `src/test/replRegistry.test.ts`, `src/test/replTree.test.ts`,
  `src/test/replStatusBar.test.ts`, `src/test/replConfig.test.ts`

- [ ] **Step 1: Delete the ad-hoc tests**
  Remove the cases that only describe ad-hoc behaviour: in
  `replRegistry.test.ts`, the ad-hoc lifecycle, "configuration changes leave
  ad-hoc sessions alone", and the promotion case ("saving a configuration over
  an ad-hoc session keeps it after it stops"); in `replTree.test.ts`, the
  `replAdHoc` context-value case and the `isAdHoc` argument threaded through the
  rest; in `replStatusBar.test.ts`, the unnamed-session case (the "named after
  its address" case stays — a *configuration* may still be called
  `127.0.0.1:7890`); in `replConfig.test.ts`, the `readNreplPort` suite.
  Everything else must keep passing untouched — that is the point of doing the
  subtraction first.

- [ ] **Step 2: Run tests to verify the suite is still green**
  Run: `make test`
  Expected: PASS — what remains describes the behaviour that stays.

- [ ] **Step 3: Remove the implementation**
  From `replRegistry.ts`: `addAdHoc`, `isAdHoc`, `adHocNames`, `forget()`, the
  `adHocNames.delete(config.name)` promotion line in `setConfigs`, the ad-hoc
  branch in `onSessionState`, and the `adHocNames` clear in `dispose()`. The
  `retire()` / `undead` path stays — it belongs to configured sessions.
  From `replTree.ts`: `isAdHoc` leaves `ReplTreeSource` and `presentSession`'s
  options (now just `{ isActive: boolean }`), and `contextValueFor` loses its
  `replAdHoc` branch. From `replStatusBar.ts`: `active.name` becomes required
  again. From `replConfig.ts`: `readNreplPort`, whose only caller was the prompt
  deleted in Task 4. From `extension.ts`: the ad-hoc guards in `editReplConfig`
  and `deleteReplConfig`, which can no longer be true.

- [ ] **Step 4: Compile, lint, full test run**
  Run: `make check`
  Expected: PASS, and `grep -rni "adhoc" src package.json` finds nothing.

- [ ] **Step 5: Check the pane in a real window**
  In the extension host, run **Connect to Running nREPL** with no configurations
  and confirm it offers to add one instead of a dead end; add a `connect`
  configuration and confirm the same command now lists it. Confirm every row
  still shows its Edit and Delete actions.

- [ ] **Step 6: Commit**
  `git commit -m "Remove the ad-hoc session machinery"`

### Task 6: Documentation

**Files:**
- Modify: `README.md`, `CHANGELOG.md`

- [ ] **Step 1: Write the docs** (use /writing-clearly)
  In the README's REPL section, replace the description of the prompt-based add
  flow: the **+** button and the row's pencil both open a form in the sidebar,
  with the type selector, the fields per type, and Save / Delete / Cancel. Say
  where it saves — workspace settings, or user settings when no folder is open —
  and keep the note that `settings.json` remains the source of truth and can
  still be edited by hand. Remove the "In a hurry?" paragraph pointing at the
  ad-hoc *Connect to host:port…* entry, and rewrite the **Connect to Running
  nREPL** command's description in the Commands list: it now connects a
  configured REPL. Add a CHANGELOG entry covering the form, the inline Edit
  action, Delete from the form, and the removal of unsaved ad-hoc connections —
  the one behaviour change an existing user will notice.

- [ ] **Step 2: Commit**
  `git commit -m "Document the REPL configuration form"`
