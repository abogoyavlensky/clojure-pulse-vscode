# Sidebar Row Click Opens Edit Form Implementation Plan

> **For agentic workers:** Use executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a click on a REPL row open its edit form (as REPL Commands rows already do), drop the inline pencil from both panes, and give REPL rows an inline "Show REPL Output" icon, offered in every REPL state, instead.

**Tech Stack:** VS Code extension API (TreeDataProvider, `view/item/context` menus), TypeScript, Mocha via `vscode-test`.

---

## Design

### Problem

The three sidebar panes disagree about what a row click means. A REPL row
opens the REPL's output channel, a REPL Commands row opens its edit form, and
a project row only expands. The pencil is therefore redundant on Commands rows
and is the only visible route to the form on REPL rows.

### Change

- **REPL pane.** Row click runs `clojurePulse.editReplConfig`. The inline
  pencil goes away. A new inline `clojurePulse.showReplOutput` icon (the
  command's existing `$(output)` icon) appears on every row, in the slot the
  pencil used.
- **REPL Commands pane.** Row click already opens the edit form. The inline
  pencil goes away; the play icon stays.
- **Context menus, commands, palette, keybindings.** Unchanged. Edit stays in
  both right-click menus and Show REPL Output stays in the REPL row's menu.

Resulting inline icons:

| Row state          | Inline icons               |
|--------------------|----------------------------|
| REPL stopped       | start, output              |
| REPL running       | set active, stop, output   |
| Custom command     | play                       |

### Decisions

- **Click argument stays a plain name string** on REPL rows. `editReplConfig`
  resolves its argument through the shared `sessionFor` helper, which accepts a
  string or a tree node, so nothing in `extension.ts` changes.
- **Output icon is `inline@3`**, after start/stop (or set-active/stop), where
  the pencil sat. A running row still shows three icons, the width the
  2026-07-29 form plan accepted.
- **Output icon has no `viewItem` gate.** It is offered in every REPL state
  (VS Code still shows inline icons only on hover or selection). A configured
  REPL keeps its channel across stops and restarts, and `showReplOutput`
  already accepts any configured REPL.
- **No CHANGELOG entry.** The repo has none; release notes are generated from
  PR titles. The PR title must say the click behaviour changed, since 0.5.0
  users will now get a form where they used to get the output.

### Testing

The tree unit tests pin each row's click command; the REPL one flips from
`showReplOutput` to `editReplConfig`. Inline menu entries live in
`package.json` and are not unit-tested (the manifest test only checks the
palette hiding list), so the menu change is verified by running the extension
and looking at the pane.

## File Structure

- Modify: `package.json` — `view/item/context` menus: remove the two inline
  pencil entries, add the inline output entry.
- Modify: `src/repl/replTree.ts` — click command becomes `editReplConfig`;
  header comment describes the click.
- Modify: `src/repl/customCommandsTree.ts` — header comment only (the pencil
  was a manifest entry, not code here).
- Modify: `src/test/replTree.test.ts` — click test asserts the edit command.
- Modify: `README.md` — four sentences that describe the pencil or
  click-to-open-output.

## Tasks

### Task 1: REPL row click opens the edit form

**Files:**
- Modify: `src/repl/replTree.ts`
- Test: `src/test/replTree.test.ts`

- [x] **Step 1: Update the failing test**
  In `src/test/replTree.test.ts`, rename the test "tree items open the
  session's output on click" to "tree items open the edit form on click" and
  change the command assertion to `"clojurePulse.editReplConfig"`. Keep the
  `arguments` assertion as `["dev"]` (a plain name string, as today).

- [x] **Step 2: Run the test to verify it fails**
  Run: `make test`
  Expected: the renamed test FAILS with
  `'clojurePulse.showReplOutput' !== 'clojurePulse.editReplConfig'`.

- [x] **Step 3: Change the click command**
  In `src/repl/replTree.ts` `getTreeItem`, set `item.command` to
  `clojurePulse.editReplConfig` with title `Edit REPL Configuration` and the
  same `[session.name]` argument. Update the file's header comment so it
  says a row click opens the edit form and the output is the inline action.

- [x] **Step 4: Run the tests to verify they pass**
  Run: `make test`
  Expected: PASS, all suites green.

- [x] **Step 5: Commit**
  `git commit -am "REPL row click opens the edit form"`

### Task 2: Swap the inline icons in the manifest

**Files:**
- Modify: `package.json`
- Modify: `src/repl/customCommandsTree.ts`

- [x] **Step 1: Edit the `view/item/context` menus**
  In `package.json`:
  - Remove the entry `clojurePulse.editReplConfig` with
    `"group": "inline@3"` (the REPL pencil). Keep the `2_config@1` entry.
  - Add an entry for `clojurePulse.showReplOutput` with
    `"when": "view == clojurePulse.replManager"` and `"group": "inline@3"`,
    placed right after the `stopRepl` inline entry so the inline entries stay
    grouped together. Keep the existing `1_output@1` context-menu entry.
  - Remove the entry `clojurePulse.editCustomReplCommand` with
    `"group": "inline@2"` (the Commands pencil). Keep the `2_config@1` entry.

- [x] **Step 2: Update the Commands tree comment**
  In `src/repl/customCommandsTree.ts`, the header comment says "running is the
  inline play action only". It still is; adjust the wording so it also notes
  the play icon is the row's only inline action (edit is the click and the
  context menu).

- [x] **Step 3: Verify the manifest and build**
  Run: `make test`
  Expected: PASS (`pretest` compiles and lints; the manifest test still
  passes because the palette hiding list is untouched).

- [x] **Step 4: Check the panes in the extension host**
  Use /run to launch the Extension Development Host on a workspace with one
  `create` and one `connect` REPL configuration and one custom command.
  Confirm:
  - A stopped REPL row of either kind shows the play and output icons, no
    pencil. Include a REPL that has never been started: its output icon must
    still open (and create) its channel.
  - A running REPL row shows set-active, stop, and output icons.
  - Clicking a REPL row opens the REPL form on that configuration.
  - The output icon opens the `REPL: <name>` channel on stopped and running
    rows.
  - A REPL Commands row shows only the play icon, and clicking the row opens
    the command form.
  - Right-click menus still list Edit on both panes and Show REPL Output on
    REPL rows.

- [x] **Step 5: Commit**
  `git commit -am "Replace inline pencils with an inline Show REPL Output icon"`

### Task 3: README

**Files:**
- Modify: `README.md`

- [x] **Step 1: Update the four sentences**
  - Around line 378: "The **+** on the view title opens a form in an editor
    tab, and so does the pencil on any row." → "...and so does a click on any
    row."
  - Around line 455: "Click a row to open it." → the output icon on a row
    opens it (say it in prose, e.g. "The output icon on a row opens it.").
  - Around line 687, **Edit REPL Configuration**: "(also the pencil on its
    row)" → "(also a click on its row)".
  - Around line 689, **Show REPL Output**: add "(also the output icon on its
    row)".
  The REPL Commands section (around line 635) already says a click opens the
  form and the play button runs the command; leave it.

- [x] **Step 2: Reread the affected sections**
  Use /writing-clearly. Check no other sentence in README still promises a
  pencil on a REPL or Commands row (`grep -n pencil README.md` should list
  only the External Libraries project row, around line 320).

- [x] **Step 3: Commit**
  `git commit -am "README: row click opens the form, output icon opens the channel"`

### Task 4: Open the pull request

- [ ] **Step 1: Push and open the PR**
  Title must name the behaviour change, since it becomes the release note,
  e.g. "Sidebar row click opens the edit form; output moves to an inline icon".
  Body: two sentences on what changed and why (consistency between panes),
  and a note that the REPL output is still reachable from the status bar,
  the REPL menu, and the palette.

---

## Completion summary

**Status: Tasks 1–3 completed; Task 4 (push + PR) pending confirmation.**

Implemented, in three commits on `sidebar-row-click-edit`:

- `14d5e90` REPL row click opens the edit form — `replTree.ts` click command
  is `editReplConfig`; test renamed and asserts it.
- `4e9b2b4` Replace inline pencils with an inline Show REPL Output icon —
  `package.json` menus: REPL pencil `inline@3` replaced by `showReplOutput`,
  Commands pencil `inline@2` removed; `customCommandsTree.ts` comment.
- `a88e70d` README: the four sentences updated; `grep pencil` lists only the
  External Libraries row.

Verification: `make test` green after each task and on the final tree
(854 passing). Extension Development Host driven under xvfb via Playwright
(`.tmp/edh/driver.mjs`, throwaway) with one `create` and one `connect` REPL
and one custom command: stopped rows show start + output; running rows show
set-active + stop + output; output icon opens `REPL: <name>` on a
never-started, a stopped, and a running row; REPL row click opens the REPL
form; Commands row shows only play and its click opens the command form;
both context menus unchanged. Codex reviewed each commit: no findings.

Issues encountered: none in the code. The `Error: Unexpected SIGPIPE` line in
the test log is pre-existing host noise (present on the base commit too).

Deviations: none.

What the plan could have specified better: nothing — every file, line
reference, and command matched the repo.
