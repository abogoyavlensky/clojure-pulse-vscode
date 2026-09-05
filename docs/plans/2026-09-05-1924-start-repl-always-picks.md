# Start REPL Always Offers the Picker Implementation Plan

> **For agentic workers:** Use executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** With more than one REPL configuration, Start REPL without an argument always shows the picker instead of silently starting the one config that happens to be stopped.

**Tech Stack:** TypeScript VS Code extension, Mocha integration tests via `@vscode/test-cli` with the fake nREPL server.

---

## Design

### Problem

`pickSession` in `src/extension.ts` skips the quick pick when exactly one
session matches its predicate. Start REPL's predicate is `state === "stopped"`,
so with two configurations where one is already running, the other starts
with no prompt. A user who wants to bring up both REPLs one after another
never gets to choose, and a user who wanted a different one has launched a
process they did not ask for.

### Principle

Ask when choosing among equals; do not ask when live state has already chosen.

- For **Start REPL**, every stopped configuration is an equal candidate. The
  auto-pick is only right when a single configuration exists at all.
- For **Stop REPL**, **Restart REPL** and **Set Active REPL**, candidates are
  distinguished by live state. "The only one running" is the obvious target,
  so the auto-pick stays. Restart already goes further and prefers the active
  REPL without asking.

### Behaviour after the change

Start REPL without an argument:

| Configurations | Behaviour |
|---|---|
| none | opens the add form (unchanged) |
| exactly one | starts it, or reports it is already running (unchanged) |
| two or more, some stopped | always shows the picker listing the stopped ones, even if only one is stopped |
| two or more, all running | "Every configured REPL is already running." (unchanged) |

A one-item picker is acceptable: the user still confirms with Enter, and the
description column already says `stopped` or `connect · host:port`, so the
row explains itself. Start REPL with a name argument, as from a keybinding or
a tree row, is unchanged.

### Implementation shape

`pickSession` gains an option that turns the single-match shortcut off. The
smallest form is a fifth parameter with a default, so the other callers do not
change:

```ts
async function pickSession(
  registry: ReplRegistry,
  predicate: (session: ReplSessionLike) => boolean,
  placeHolder: string,
  emptyMessage: string,
  options: { alwaysAsk?: boolean } = {},
): Promise<string | undefined>
```

When `alwaysAsk` is true, a single match still goes through
`showQuickPick`. `startRepl` passes `{ alwaysAsk: registry.sessions.length > 1 }`
and carries a comment stating the principle above, so the asymmetry with Stop
and Restart reads as deliberate.

### Testing

`src/test/replManager.integration.test.ts` already has the two-fake-server
fixture and the single-configuration no-argument test ("starting with a
configured REPL connects it and opens no form"), which pins the unchanged
case. One new test there covers the new case: two configurations, one
connected, Start REPL without an argument leaves the other stopped and opens
a picker.

No existing test drives a quick pick. The pattern for this one: fire the
command without awaiting it, wait a moment, assert the other session is still
`stopped`, then dismiss the picker with `workbench.action.closeQuickOpen` and
await the command promise, which resolves with nothing started.

### Out of scope

The generated "Focus on … View" palette commands stay as they are. The README
does not describe the auto-pick and needs no change.

## File Structure

Modified:

- `src/extension.ts`: `pickSession` option, `startRepl` call site and comment.
- `src/test/replManager.integration.test.ts`: one new test.

Test commands: `make check` runs lint, type-check and the suite. Read the
`passing`/`failing` summary line rather than a piped exit code.

## Tasks

### Task 1: Start REPL asks whenever more than one REPL is configured

**Files:**
- Modify: `src/extension.ts`
- Test: `src/test/replManager.integration.test.ts`

- [x] **Step 1: Write the failing test**
  In `src/test/replManager.integration.test.ts`, inside the "REPL manager
  with several sessions" suite, after "starting with a configured REPL
  connects it and opens no form", add:

  `test("starting with several configured REPLs asks even when only one is stopped", …)`

  - Configure `a` and `b` as `connect` entries on the two fake servers, the
    way the first test in the suite does.
  - Start `a` by name and assert it is `connected`.
  - Call `executeCommand("clojurePulse.startRepl")` without awaiting; keep
    the promise, and mark a flag when it settles (`.then(() => { settled = true; })`).
  - Wait ~300 ms (a `setTimeout` promise), then assert two things: the
    command has not settled (`settled === false`), which is what tells a
    waiting picker apart from a command that returned without doing
    anything, and `api.repls.get("b")?.state === "stopped"`.
  - In a `finally`, dismiss the picker with
    `await vscode.commands.executeCommand("workbench.action.closeQuickOpen")`
    and `await` the kept promise, so a failed assertion cannot leave the
    picker open for the next test.
  - After the `finally`, assert `b` is still `stopped` and
    `api.replForm.state` is `undefined`.

- [x] **Step 2: Run the test to see it fail**
  Run: `make test > .tmp/t1a.log 2>&1; grep -E "^\s+[0-9]+ (passing|failing)|^\s+[0-9]+\) " .tmp/t1a.log`
  Expected: one failure, "starting with several configured REPLs asks even
  when only one is stopped", because `b` is `connected` after the 300 ms
  wait.

- [x] **Step 3: Add the option to `pickSession`**
  In `src/extension.ts`, extend `pickSession` with the fifth parameter from
  the Design section. Replace the `matches.length === 1` early return with
  one guarded by `!options.alwaysAsk`. Update the doc comment: "Quick-picks
  one of the sessions matching `predicate`. A single match is taken without
  asking unless `alwaysAsk` is set."

- [x] **Step 4: Make Start REPL ask**
  In `startRepl`, pass `{ alwaysAsk: registry.sessions.length > 1 }` to
  `pickSession`. Add a comment above the call:

  > Ask when choosing among equals: every stopped configuration is a
  > candidate, so with more than one configured the user picks, even if only
  > one is stopped. Stop and Restart keep the shortcut because "the only one
  > running" is not a choice.

  Leave the `registry.sessions.length === 0` branch, the predicate, the
  placeholder and the empty message as they are.

- [x] **Step 5: Lint, compile, test**
  Run: `make check > .tmp/t1b.log 2>&1; echo "exit $?"; grep -E "^\s+[0-9]+ (passing|failing|pending)|^\s+[0-9]+\) |error TS" .tmp/t1b.log`
  Expected: `exit 0`, no failing tests. The two existing no-argument tests
  ("starting with nothing configured opens the add form", "starting with a
  configured REPL connects it and opens no form") still pass.

- [x] **Step 6: Commit**
  `git commit -am "Start REPL asks which REPL when more than one is configured"`

### Task 2: Final verification

- [x] **Step 1: Confirm the other pickers are untouched**
  Run: `grep -n "alwaysAsk" src/extension.ts`
  Expected: exactly four hits: the `pickSession` doc comment, the parameter,
  the guard, and the `startRepl` call site.

- [x] **Step 2: Full check**
  Run: `make check > .tmp/t2.log 2>&1; echo "exit $?"; grep -E "^\s+[0-9]+ (passing|failing|pending)" .tmp/t2.log`
  Expected: `exit 0`, all passing.

---

## Completed

**Status: done.** Landed on `improve-start-repl-cmd` as
`7bfa851 Start REPL asks which REPL when more than one is configured`.

**What was implemented:** `pickSession` in `src/extension.ts` takes a fifth
`options: { alwaysAsk?: boolean }` parameter; the single-match shortcut is now
guarded by `!options.alwaysAsk`. `startRepl` passes
`{ alwaysAsk: registry.sessions.length > 1 }` with a comment stating the
"ask when choosing among equals" principle. Stop, Restart and Set Active are
untouched — `grep -n alwaysAsk src/extension.ts` returns exactly the four
expected hits.

**Test:** one new integration test in
`src/test/replManager.integration.test.ts`, "starting with several configured
REPLs asks even when only one is stopped". It connects `a`, fires Start REPL
without an argument without awaiting, and after ~300 ms asserts the command has
not settled and `b` is still `stopped`, then dismisses the picker in a
`finally`. It failed before the change for the expected reason (the command had
already settled, having auto-started `b`).

**Verification:** `make check` exits 0 — 823 passing, 0 failing, 2 pending.
A second-opinion codex review of the commit found no actionable regressions.

**Issues encountered:** none.

**Deviations:** none. The plan matched the code as written.

**What the plan could have specified better:** the plan said to run
`git commit -am`, which does not pick up this untracked plan document; the
plan file itself needed a separate commit. Minor — worth a line in future plans
that create a new doc.
