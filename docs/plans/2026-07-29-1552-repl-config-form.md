# REPL Configuration Form Implementation Plan

> **For agentic workers:** Use executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make one form the only way REPLs are configured: an editor-tab form for adding and editing, an inline Edit action on every row, Delete from the form, and no unsaved ad-hoc connections.

**Tech Stack:** TypeScript (VS Code extension: `WebviewPanel`, workspace settings), no new dependencies.

---

## Design

### The problem

Adding a REPL is a four-step quick-pick sequence with no way back, and the long
`create` command has to be edited in a one-line input box. Editing is worse:
`clojurePulse.editReplConfig` runs `workbench.action.openWorkspaceSettingsFile`
and leaves you to find the entry in `settings.json` yourself.

### Approach

One UI for both. A **webview panel** — an ordinary editor tab, titled `Add REPL`
or `Edit REPL: dev` — renders a form with every field visible at once. The
commands that used to prompt now open it.

An editor tab rather than a section in the sidebar: the default `create` command
runs to about 150 characters, which a ~300px sidebar wraps five times with no
room for the explanatory line that today lives only in the README. A tab also
inherits VS Code's auxiliary-window support, so dragging it out turns the form
into the floating overlay a dialog would be — for free, without reaching for
`workbench.action.moveEditorToNewWindow`, which is a UI command rather than an
API and offers no control over the window it makes. (A setting to move it there
automatically is a possible follow-up, deliberately not in this plan.)

The tree keeps its rows. VS Code cannot interleave content between tree rows, so
a form under the edited row was never reachable without hand-rolling the whole
pane — which would cost the built-in row icons, hover actions, keyboard
navigation, and empty-state welcome.

```
 server.clj   user.clj   ✎ Edit REPL: dev  ×
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│  Type       (•) Start a REPL    ( ) Connect to a running REPL   │
│                                                                 │
│  Name       [ dev                                             ] │
│                                                                 │
│  Command    [ clojure -Sdeps '{:aliases {:clojure-pulse/nrepl  ]│
│             [   {:extra-deps {nrepl/nrepl {:mvn/version "1.7.0"]│
│             Runs through your shell. Add your own aliases with  │
│             -M:dev:test:clojure-pulse/nrepl                     │
│                                                                 │
│  Directory  [ .                                               ] │
│             Relative to the workspace root.                     │
│                                                                 │
│  [ Delete ]                              [ Cancel ]   [ Save ]  │
└─────────────────────────────────────────────────────────────────┘
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
enter the same data means two things to keep in sync.

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

- **Adding:** `name` empty, `type` `"create"`, `command` prefilled for the
  project (below), `cwd` `"."`, `host` `"localhost"`, `port` `".nrepl-port"`.
- **Editing:** filled from the raw settings entry, falling back to the same
  defaults for anything absent.

### Prefilling the command

A Clojure CLI command is useless in a Leiningen project, so the prefill follows
whatever build file sits at the workspace root:

| Found at the root | Prefilled command |
| --- | --- |
| `deps.edn` | `clojure -Sdeps '{:aliases {:clojure-pulse/nrepl …}}' -M:clojure-pulse/nrepl` |
| `project.clj` | `lein repl :headless` |
| `lgx.edn` | `lgx nrepl` |
| none of them | the `deps.edn` command |

Precedence follows the order already used in `activationEvents`: `deps.edn`,
then `project.clj`, then `lgx.edn` — it only matters in a mixed repository, and
the field is editable anyway.

All three announce themselves with the line `parseNreplPort` matches — `lgx nrepl`
was checked against a real server and prints
`nREPL server started on port 39553 on host 127.0.0.1 …`, the same shape as the
Clojure CLI. Leiningen's wording matches too, though it was not run during
planning; all three also write `.nrepl-port`, which is the fallback if any
wording ever drifts.

Each kind carries its own one-line hint under the field — the
`-M:dev:test:clojure-pulse/nrepl` alias tip is worth showing exactly when
someone is editing a `deps.edn` command, and is noise above a `lein` one. The
hint describes the *project*, not the entry: an edit form shows the detected
kind's hint whatever command the entry happens to hold, because that is what is
true about where the command will run.

Detection is a pure function over the root's file names; the panel's
`defaultCommand` callback supplies that listing, so nothing about it needs a
`vscode` import to test. Babashka (`bb nrepl-server`) is deliberately left out:
`bb.edn` is not an activation event here, and its startup wording could not be
verified during planning.

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
- Duplicate names are possible in hand-edited settings, and the parser keeps the
  first while warning about the rest. Editing therefore replaces the **first**
  match — the one the tree is showing — and leaves later shadowed duplicates
  alone. Deleting removes **every** entry with that name, so a deleted REPL
  actually disappears instead of being replaced by the duplicate behind it.
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
- `src/test/replFormPanel.test.ts` — the controller driven through a fake
  `WebviewPanel`: `ready` gets the pending values, `save` with valid values writes
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
- `src/repl/replFormPanel.ts` — `ReplFormPanel`: owns the single webview panel,
  holds the pending form state, renders the HTML, and translates messages into
  calls on injected callbacks.
- `src/test/replConfigEdit.test.ts`, `src/test/replFormPanel.test.ts`.

**Modify:**
- `package.json` — the inline pencil menu entry for `editReplConfig`; later, the
  `replAdHoc` context value drops out of four menu `when` clauses. The form needs
  no contribution at all: panels are created imperatively.
- `src/extension.ts` — construct the panel controller; rework `addReplConfig` and
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
- Modify: `src/repl/replConfig.ts`, `src/test/replConfig.test.ts` (project-aware
  `defaultCreateCommand`)

- [x] **Step 1: Write failing tests for the project-aware command**
  In `replConfig.test.ts`: `detectProjectKind` picks `deps` for `["deps.edn"]`,
  `lein` for `["project.clj"]`, `lgx` for `["lgx.edn"]`, `deps` for a directory
  with none of them, and follows the documented precedence when several are
  present; `defaultCreateCommand` returns the existing Clojure CLI string for
  `deps` (both platforms, exactly as the current tests assert), `lein repl
  :headless` for `lein`, and `lgx nrepl` for `lgx`; `createCommandHint` mentions
  the `:clojure-pulse/nrepl` alias only for `deps`. The existing
  `defaultCreateCommand` tests move to the new options-object signature.

- [x] **Step 2: Write failing tests for the form model**
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
  trimming), replaces only the *first* of two entries sharing a name, appends
  when the original is missing, appends for a new entry, and
  **leaves every entry it did not match untouched — including non-object ones**,
  so a stray scalar in the array survives an edit; `removeEntry` drops exactly
  every entry with that name — duplicates included — and, likewise, leaves
  everything else in place.

- [x] **Step 3: Run tests to verify they fail**
  Run: `make test`
  Expected: FAIL — cannot resolve `../repl/replConfigEdit`, and
  `detectProjectKind` / `createCommandHint` do not exist.

- [x] **Step 4: Implement**
  Both modules stay pure, with no `vscode` import. `replConfigEdit.ts` reuses
  `configEntryName`, `validatePortInput`, and `parseReplConfigurations` from
  `replConfig.ts` rather than restating their rules. In `replConfig.ts`, the
  options object is deliberate: it makes every existing positional
  `defaultCreateCommand("darwin")` call a compile error rather than a silent
  reinterpretation of the argument. Pin these signatures — Tasks 2 and 3 call
  them:

  ```ts
  // replConfig.ts
  export type ProjectKind = "deps" | "lein" | "lgx";
  export function detectProjectKind(rootFileNames: readonly string[]): ProjectKind;
  export function defaultCreateCommand(options?: {
    kind?: ProjectKind;          // defaults to "deps"
    platform?: NodeJS.Platform;  // defaults to process.platform
  }): string;
  export function createCommandHint(kind: ProjectKind): string;
  ```

  ```ts
  // replConfigEdit.ts
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

- [x] **Step 5: Run tests to verify they pass**
  Run: `make test`
  Expected: PASS.

- [x] **Step 6: Commit**
  `git commit -m "Add the REPL configuration form model"`

> Deviation: `upsertEntry` matches the entry the tree is *showing* rather than
> the literally first entry carrying the name. A malformed namesake before a
> valid one is skipped by the parser, so replacing the first match would leave
> the shown REPL configured under its old name after a rename. Same intent the
> plan states ("the one the tree is showing"), sharper rule. Found by the codex
> review.

### Task 2: Form panel (`replFormPanel.ts`)

**Files:**
- Create: `src/repl/replFormPanel.ts`, `src/test/replFormPanel.test.ts`

- [ ] **Step 1: Write failing tests**
  Drive the controller through a fake `WebviewPanel` — an object literal with a
  `webview` that records `postMessage` calls and captures the
  `onDidReceiveMessage` listener so the test can fire messages, plus `reveal`,
  `dispose`, a settable `title`, and an `onDidDispose` the test can trigger.
  Inject the panel factory alongside `readEntries` (returning the raw array,
  scalars and all), `writeEntries`, `defaultCommand` — which returns
  `{ command: string; hint: string }`, both derived from the detected project
  kind — and `confirmDelete`, so
  nothing touches settings or the real window. Cover: `open()` creates a panel
  and a `ready` message posts the pending values and mode; a `save` with valid
  values calls `writeEntries` with the upserted array and disposes the panel; a
  `save` with an invalid name writes nothing, keeps the panel open, and posts the
  field errors back with the values the user typed; a `save` whose `writeEntries`
  rejects keeps the panel open and posts that message in the `form` error slot; a
  `delete` in edit mode calls the injected `confirmDelete`, writes the array
  without that entry when it resolves true, and writes nothing when it resolves
  false; `cancel` writes nothing and disposes the panel; opening a second form
  while one is open reuses it — `reveal` is called, no second panel is created,
  and the new values are posted. Pin the lifecycle explicitly: after a successful
  save, a confirmed delete, and a cancel, the panel is disposed exactly once and
  `state` is cleared; and a panel disposing on its own — the user closing the tab
  — clears `state` too.

- [ ] **Step 2: Run tests to verify they fail**
  Run: `make test`
  Expected: FAIL — cannot resolve `../repl/replFormPanel`.

- [ ] **Step 3: Implement**
  `ReplFormPanel`, holding at most one `vscode.WebviewPanel` at a time. Public
  surface:

  ```ts
  open(mode: { kind: "add" } | { kind: "edit"; name: string }): void;
  submit(values: ReplFormValues): Promise<void>;  // validate, write, close
  requestDelete(): Promise<void>;                 // confirm, remove, close
  cancel(): void;
  close(): void;
  dispose(): void;
  get state(): { mode; values } | undefined;
  ```

  The incoming-message handler does nothing but dispatch to `submit`,
  `requestDelete`, and `cancel`. That is what makes the form testable at all:
  VS Code offers no way to post a message *into* a real webview, so an
  integration test drives these methods — the very same entry points the
  webview's buttons reach — rather than a simulated click. Message protocol,
  shared with the HTML:

  ```ts
  // host → webview
  { type: "load"; mode: "add" | "edit"; title: string; values: ReplFormValues;
    errors: ReplFormErrors; commandHint: string }
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
  input box is that the default command runs to ~150 characters. Each field
  carries a line of help beneath it — which is what the extra width buys; the
  command's line is the `commandHint` from the load message, so a Leiningen
  project is not told about `-M:` aliases. Save posts the whole
  `ReplFormValues`.
  Delete renders only in edit mode, separated from Cancel and Save (`margin-right:
  auto`) so it cannot be hit by accident, and uses
  `--vscode-inputValidation-errorBorder` rather than a filled destructive
  colour.

  Create the panel with view type `clojurePulse.replForm`, `ViewColumn.Active`,
  `enableScripts: true`, and — unlike the old transcript panel —
  `retainContextWhenHidden: true`: a form is worth a little memory to survive
  the user tabbing away mid-edit. Set `panel.title` from the mode (`Add REPL` or
  `Edit REPL: dev`) and `panel.iconPath` to `images/repl-icon.svg`, which has
  been orphaned since the transcript panel was removed. Handle
  `panel.onDidDispose` — the user can close the tab at any time — by clearing
  `state`.

- [ ] **Step 4: Run tests to verify they pass**
  Run: `make test`
  Expected: PASS.

- [ ] **Step 5: Commit**
  `git commit -m "Add the REPL configuration form panel"`

### Task 3: Wiring — commands, row action, contributions

**Files:**
- Modify: `package.json`, `src/extension.ts`, `src/test/replManager.integration.test.ts`

- [ ] **Step 1: package.json contributions**
  Add an inline `view/item/context` entry for `clojurePulse.editReplConfig` —
  `"when": "view == clojurePulse.replManager && viewItem != replAdHoc"`,
  `"group": "inline@3"` — so the pencil follows the existing start/stop and
  set-active icons; leave the existing context-menu entry in place. The form
  itself contributes nothing: a `WebviewPanel` is created imperatively, with no
  view id, no `when` clause, and no context key to keep in sync.

- [ ] **Step 2: Wire the panel and rework the commands**
  In `setupRepl`, construct `ReplFormPanel` with the real callbacks:
  `readEntries` → the **raw** `clojurePulse.replConfigurations` value (an array
  as-is, or `[]`), `writeEntries` → `config.update("replConfigurations", …)`
  against `ConfigurationTarget.Workspace` when `vscode.workspace.workspaceFolders`
  is non-empty and `Global` otherwise, `defaultCommand` → read the workspace
  root's file names (`fs.readdirSync`, or `[]` when no folder is open), pass
  them through `detectProjectKind`, and return
  `{ command: defaultCreateCommand({ kind }), hint: createCommandHint(kind) }`,
  `confirmDelete` → the modal warning `deleteReplConfig` already shows, and a
  panel factory calling `vscode.window.createWebviewPanel` — the seam Task 2's
  tests replace. It needs `context.extensionUri` for the tab icon, which
  `setupRepl` already receives.
  Note that `currentReplConfigurations()` is *not* the reader here: it filters
  out non-object entries, which the form must preserve.

  Give the file one `writeReplConfigurations(entries: unknown[])` helper that
  picks the target and performs the update, and use it for *both* the panel's
  `writeEntries` callback and `deleteReplConfig`. Right-click Delete must also
  move to the raw array and `removeEntry`: today it writes
  `ConfigurationTarget.Workspace` unconditionally and filters through
  `currentReplConfigurations()`, so without that change it would fail in the
  folderless window the form now supports, and would keep dropping malformed
  entries the parser only warns about.
  Push it onto `context.subscriptions` so a lingering form closes with the
  extension.

  Rework `addReplConfig` to open the form in add mode and nothing else — its
  workspace-folder guard goes away entirely, since a folderless window now saves
  to user settings. Rework `editReplConfig` to resolve a session name through the
  existing `sessionFor` helper (tree node, keybinding string, or quick pick) and
  open the form in edit mode — it no longer runs
  `workbench.action.openWorkspaceSettingsFile`. Its quick pick lists only
  non-ad-hoc sessions, and a name resolving to an ad-hoc session is refused with
  a message, exactly as `deleteReplConfig` does. Delete `promptCreateEntry`,
  `promptConnectEntry`, and the quick-pick body of `addReplConfig`. Add the
  controller to `ExtensionApi` as `replForm`.

- [ ] **Step 3: Update the integration tests**
  In `replManager.integration.test.ts`: `clojurePulse.addReplConfig` leaves the
  form in add mode with the default command prefilled;
  `clojurePulse.editReplConfig` with a configured name loads that entry's values
  in edit mode; a second edit replaces the pending values; `editReplConfig` on an
  ad-hoc session's name opens no form. Assert through `api.replForm.state`, and
  close the form in `teardown` so one test's tab cannot leak into the next.
  The user-settings fallback also makes a full round trip testable for the first
  time: with no folder open the form writes to `Global`, which the suite already
  uses. Add a test that opens the add form, calls `api.replForm.submit(values)` —
  the same entry point the webview's Save button reaches, since a real webview
  cannot be scripted from a test — and asserts the new row appears in the
  registry and the form closed. Reset the setting in `teardown`, as the existing
  tests do. A `cancel()` test covers the other side: no write, form closed.
  Cover deletion the same way — `clojurePulse.deleteReplConfig` on a configured
  name removes its row — which, with no folder open, is precisely the case that
  would break if either delete path still wrote to the workspace target.
  Settings changes reach the registry through a configuration event, so assert
  with the suite's existing `waitUntil` helper rather than reading straight
  after the call.

- [ ] **Step 4: Compile, lint, full test run**
  Run: `make check`
  Expected: PASS, and `grep -rn "promptCreateEntry\|promptConnectEntry" src` finds nothing.

- [ ] **Step 5: Check the form in a real window**
  Launch the extension host (F5) in a project with a `deps.edn`. Add a REPL from
  the **+** button, watch the form open as an editor tab with its own icon, save
  it, and confirm the tab closes and the row appears and starts. Repeat in a
  Leiningen project (a bare `project.clj` is enough) and confirm the command is
  prefilled as `lein repl :headless` with a hint that says nothing about
  `-M:` aliases. Press the
  pencil on that row, change the command, save, and confirm `settings.json`
  shows the edit with no `"cwd": "."` noise. Switch the type selector to `connect` and back to `create`,
  confirming the command you typed is still there — the webview's own field
  switching has no automated coverage, so this is where it gets checked. Save
  after switching to `connect` and confirm `command` is gone from the entry.
  Cancel a form and confirm the tab closes. Open a form, switch to another tab
  and back, and confirm your in-progress edits survived
  (`retainContextWhenHidden`). Drag the form's tab out into a floating window and
  confirm it still saves from there — that is the overlay experience this shape
  was chosen for. Finally, put a stray `"junk"` string in the
  `replConfigurations` array by hand, edit a REPL through the form, and confirm
  the stray entry is still there afterwards.

- [ ] **Step 6: Commit**
  `git commit -m "Add and edit REPL configurations through a form"`

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
  simplify the three `viewItem != replAdHoc` clauses — the inline pencil added
  in Task 3, and the context-menu Edit and Delete — to plain
  `view == clojurePulse.replManager`. Show-output's clause is already
  unrestricted and needs no change. Nothing can produce that context value once
  Step 3 lands.

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
  flow: the **+** button and the row's pencil both open a form in an editor tab,
  with the type selector, the fields per type, and Save / Delete / Cancel.
  Mention that the tab can be dragged into a floating window if you prefer the
  form beside your code, and that the command comes prefilled for the project's
  build file — `deps.edn`, `project.clj`, or `lgx.edn`. Say where it saves —
  workspace settings, or user settings when no folder is open — and keep the
  note that `settings.json` remains the source of truth and can still be edited
  by hand. Remove the "In a hurry?" paragraph pointing at the
  ad-hoc *Connect to host:port…* entry, and rewrite the **Connect to Running
  nREPL** command's description in the Commands list: it now connects a
  configured REPL. Add a CHANGELOG entry covering the form, the inline Edit
  action, Delete from the form, the project-aware command prefill, and the
  removal of unsaved ad-hoc connections — the one behaviour change an existing
  user will notice.

- [ ] **Step 2: Commit**
  `git commit -m "Document the REPL configuration form"`
