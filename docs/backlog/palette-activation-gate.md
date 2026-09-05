# Palette commands show in workspaces with no Clojure in them

**Status: open**

## Problem

`contributes.commands` is static: VS Code reads it from the manifest before
the extension activates, so every Clojure Pulse command appears in the Command
Palette of a Python or TypeScript workspace that has never opened a `.clj`
file. Twenty entries under "Clojure Pulse" in a project that does not use it
is noise for everyone who installs the extension once and keeps it.

## Proposed fix

Gate the palette entries on a context key that only exists once the extension
has activated:

1. At activation, call `vscode.commands.executeCommand("setContext",
   "clojurePulse.active", true)`. The extension already sets a context key
   this way in `src/repl/inlineResults.ts` (`clojurePulse.hasInlineResults`),
   so the pattern is established.
2. In `package.json`, give every palette-visible command a
   `menus.commandPalette` entry with `"when": "clojurePulse.active"`. An unset
   context key evaluates to false, so before activation nothing shows, and the
   activation events (`onLanguage:clojure`, `workspaceContains:**/deps.edn`
   and friends) already describe exactly the workspaces that should see the
   commands.

Two things to keep straight when doing it:

- `clojurePulse.showClojureDocs` already has `"when": "editorLangId ==
  clojure"`. Combine rather than replace: `clojurePulse.active &&
  editorLangId == clojure`.
- `src/test/manifest.test.ts` decides visibility by "no `commandPalette`
  entry with `when === "false"`". With every command carrying a `when`, the
  test needs a richer rule: hidden means `when === "false"`, and visible means
  the `when` is exactly the activation key (optionally combined with a
  language check). Keep the explicit list of twenty commands; that is the
  point of the test.

## Origin

Deferred from the command palette trim,
`docs/plans/2026-09-05-1445-minimize-command-palette.md` (2026-09-05). The
trim reduced the palette to the commands users reach for by name; this would
make them appear only where Clojure Pulse is in use.
