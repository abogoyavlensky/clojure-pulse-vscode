# Start REPL with Nothing Configured Implementation Plan

**Status: complete** (see the summary at the end).

> **For agentic workers:** Use executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Running **Start REPL** with no REPLs configured opens the configuration form instead of reporting that every configured REPL is already running.

**Tech Stack:** TypeScript (VS Code extension), no new dependencies.

---

## Design

### The problem

`clojurePulse.startRepl` with an empty `clojurePulse.replConfigurations` shows
*"Every configured REPL is already running."* The statement is vacuously true
and useless: there is nothing to start because there is nothing at all. The
command dead-ends where the pane's welcome view and `connectRepl` both offer to
add a REPL.

The message comes from `pickSession` (`src/extension.ts:411`), which collapses
two situations into one string:

```ts
const matches = registry.sessions.filter(predicate);
if (matches.length === 0) {
  vscode.window.showInformationMessage(emptyMessage);   // :419
  return undefined;
}
```

Nothing matched the predicate, and nothing exists, arrive at the same line. Of
the six call sites only `startRepl` is misleading: `stopRepl` and
`setActiveRepl` stay true when empty, and the three that pass `() => true`
already say *"No REPLs are configured yet."*

### Approach

With nothing configured, **Start REPL** has exactly one possible continuation,
so it takes it: the form opens in add mode. Cancel closes the tab and writes
nothing, so a wrong guess costs one Escape.

The fallback goes in `startRepl`'s **pick callback**:

```ts
const session = await sessionFor(registry, arg, async () => {
  if (registry.sessions.length === 0) {
    await vscode.commands.executeCommand("clojurePulse.addReplConfig");
    return undefined;
  }
  return pickSession(registry, /* … unchanged … */);
});
```

`sessionFor` (`:398`) runs that callback only when no name came from the
argument, which is the palette path and a keybinding that passes none. A
keybinding with `"args": "dev"` and nothing configured therefore still gets the
accurate `no REPL named "dev" — check clojurePulse.replConfigurations` error
rather than an editor tab it did not ask for.

Nothing inside the extension can reach the new branch. `activeSession` offers
*Start REPL* only when a stopped session exists (`:750`), and the status-bar
item routes to `startRepl` only when `total > 0`, falling back to `connectRepl`
otherwise. The branch belongs to a deliberate human invocation.

### Decisions

- **The condition is `sessions.length === 0`**, not "nothing startable". With
  configurations present but all running, *"Every configured REPL is already
  running."* is true and stays. That string was wrong only because it was
  reachable when nothing existed; this makes it reachable only when accurate.
- **The guard lives in `startRepl`, not `pickSession`.** `stopRepl` and
  `setActiveRepl` reach the same helper, and offering to create a REPL when you
  asked to stop one is a non-sequitur. Their messages are left alone.
- **The form opens through `executeCommand("clojurePulse.addReplConfig")`**, as
  `connectRepl` does, so `ReplFormPanel` need not be threaded through
  `startRepl` and `sessionFor`.
- **Scope stops there.** The three `() => true` call sites are already correct;
  this is not the general empty-state refactor.

### Testing

`src/test/replManager.integration.test.ts` already asserts through
`api.replForm.state`, which is what makes this behaviour verifiable at all - a
notification would not be.

- With nothing configured, `clojurePulse.startRepl` leaves the form open in add
  mode. The test must first wait for the registry to be empty: teardown's
  configuration reset reaches the registry through a configuration event, and
  the suite's `setConfigurations(api, [])` waits only for named sessions.
- With one stopped configuration, the same command connects it and opens no
  form, pinning the branch from the other side.

---

## File Structure

**Modify:**
- `src/extension.ts` - the pick-callback guard in `startRepl`.
- `src/test/replManager.integration.test.ts` - both branches of the guard.
- `README.md` - the **Start REPL** entry in the Commands list.
- `CHANGELOG.md` - a clause on the existing REPL-form bullet.

No new files, no `package.json` change: the command, its menus, and the form
all exist already.

---

### Task 1: Open the form when no REPL is configured

**Files:**
- Modify: `src/extension.ts`, `src/test/replManager.integration.test.ts`,
  `README.md`, `CHANGELOG.md`

- [x] **Step 1: Write the failing tests**
  In `replManager.integration.test.ts`, alongside the existing form tests:

  *"starting with nothing configured opens the add form"* - wait for
  `api.repls.sessions.length === 0` with the suite's `waitUntil` helper, run
  `vscode.commands.executeCommand("clojurePulse.startRepl")` with no argument,
  and assert `api.replForm.state?.mode` deep-equals `{ kind: "add" }`.

  *"starting with a configured REPL connects it and opens no form"* - configure
  one `connect` entry pointing at the suite's fake server `a` through
  `setConfigurations`, run the same argument-less command, then assert the
  session reached `connected` and `api.replForm.state` is `undefined`.

  Teardown already closes the form and resets the configurations.

- [x] **Step 2: Run the tests to verify they fail**
  Run: `make test`
  Expected: FAIL - the first test finds `api.replForm.state` undefined, because
  the command reports "Every configured REPL is already running." instead.

- [x] **Step 3: Implement the guard**
  In `startRepl` (`src/extension.ts`), make the `sessionFor` pick callback
  async: when `registry.sessions.length === 0`, await
  `vscode.commands.executeCommand("clojurePulse.addReplConfig")` and return
  `undefined`; otherwise call `pickSession` with its existing arguments and
  messages, unchanged. Nothing else in the function moves - `sessionFor`
  already treats `undefined` as "nothing to act on".

- [x] **Step 4: Run the tests to verify they pass**
  Run: `make test`
  Expected: PASS.

- [x] **Step 5: Update the docs** (use /writing-clearly)
  In `README.md`, extend the **Clojure Pulse: Start REPL** entry in the
  Commands list: with no REPLs configured yet, it opens the form instead.
  In `CHANGELOG.md`, add a clause to the existing REPL configuration form
  bullet saying **Start REPL** opens the form when nothing is configured.

- [x] **Step 6: Compile, lint, full test run**
  Run: `make check`
  Expected: PASS.

- [x] **Step 7: Commit**
  `git commit -m "Open the REPL form when there is nothing to start"`

> Deviation: added a third assertion, to the existing "starting an unknown REPL
> reports an error" test, that no form opens for a *named* start. The design's
> load-bearing claim about `"args": "dev"` had no test pinning it.

---

## Completed

**Status: complete.** One commit, `make check` green at 386 tests, and the
codex review of the commit came back with no findings.

### What was implemented

`startRepl`'s `sessionFor` pick callback now checks for an empty registry
first, and opens the form through `executeCommand("clojurePulse.addReplConfig")`
when there is nothing to start. Because `sessionFor` runs that callback only
when the argument carried no name, a keybinding passing `"args": "dev"` still
gets the not-found error. `pickSession` and its five other call sites are
untouched, and "Every configured REPL is already running." now appears only
when it is true.

Three integration tests cover it: the empty registry opens the form, a single
configured REPL is connected with no form, and a named-but-unknown REPL errors
without one. README and CHANGELOG each gained a line.

### Issues encountered

None. The plan matched the code it was written against.

### Deviations

- Added the named-start assertion described above.

### What the plan could have specified better

The plan argued at length that a named start must keep its error, then asked
for tests covering only the two empty-vs-configured branches. A plan that makes
a claim central to its design should list the assertion that pins it.
