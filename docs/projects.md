# Navigation, libraries, and projects

[Documentation](README.md) · [Clojure Pulse](../README.md)

## Language intelligence

[clj-pulse](https://github.com/abogoyavlensky/clj-pulse) provides:

- Go to definition in project files, JAR sources, git/`:local/root`
  dependencies, and `clojure.core`.
- Completion, hover documentation, and signature help.
- Find references and rename across indexed sources.
- Document outlines and workspace symbol search.
- Namespace code actions, including Add require and Clean namespace.
- Keyword and Integrant-key navigation, plus JDK interop support.

Platform builds bundle the server. The language-server status item shows
whether it is starting, running, stopped, or in error; click it for its log.
Hover for version, source (bundled or external), and linting information.
The REPL and language server work independently.

The extension recognizes `.clj`, `.cljs`, `.cljc`, `.edn`, `.bb`, and `.lg`.
Recognizing a file extension does not imply full runtime support. See the
[server's feature reference](https://github.com/abogoyavlensky/clj-pulse/blob/master/docs/features.md)
for language coverage and limitations.

## External Libraries

The **External Libraries** panel lists the dependencies resolved by clj-pulse.
Expand a library to browse its contents. JAR sources open read-only;
directory dependencies open from disk. Go to definition, hover, and completion
also work within JAR sources. Rename cannot edit read-only dependency files.

For deps.edn projects the tree includes the resolved transitive classpath;
lgx projects show git/`:local/root` dependencies. Leiningen dependency discovery
is best effort and direct-dependencies-only. The empty state explains how to
generate a classpath for each project type. The tree updates after re-indexing,
and the refresh button rescans projects and their enabled classpaths.

## Monorepos

A workspace holding several Clojure projects - a root plus `apps/backend`,
`libs/common`, and so on - needs no configuration. clj-pulse detects every
directory with a `deps.edn`, `project.clj`, or `lgx.edn` (up to four levels
deep, honoring `.gitignore`), indexes each project's sources, and picks up
whatever classpath its `.cpcache` already holds. Navigation and rename work
across the whole workspace.

In a multi-project workspace the External Libraries panel groups its tree by
project: each row names the project, its build tool, and its classpath
status, with the resolved libraries underneath. While any project's
classpath is resolving, a progress bar runs across the view (and the server
reports the same work in the status bar). The refresh button asks the server
to rescan: it re-detects projects and re-resolves every enabled classpath  - 
the way to retry after an error, or to pick up a newly created subproject.
(Detection honors `.gitignore`, so a subproject in a gitignored directory
still needs a `clojurePulse.projects` entry; rescan then picks it up. Against
an older clj-pulse without rescan support, the button just repaints the
view.)

Resolving a project's *full* classpath - aliases included - runs its
classpath command (`clojure -A:dev:test -Spath` for deps.edn projects,
`lein classpath` for Leiningen; lgx projects resolve internally, without a
command). The first run may download dependencies, so only the root project
runs it by default. To enable it for a subproject, click the play button on
the project's row (the stop button disables it again). The button writes the
`clojurePulse.projects` setting in workspace settings; the panel follows the
setting, so editing `settings.json` by hand works too. For the full edit  - 
the classpath command, or adding a project clj-pulse didn't detect - use the
pencil on a project's row, or the `+` on the view title. Both open a form
that writes the same setting; its "Remove from settings" button drops the
entry, which removes an added project and resets a detected one to defaults:

```json
{
  "clojurePulse.projects": [
    {
      "path": "apps/backend",
      "classpathEnabled": true,
      "classpathCommand": "clojure -A:dev:test -Spath"
    }
  ]
}
```

Entries override the server's per-project defaults and change only the keys
they name. `path` is relative to the workspace root; `"."` is the root
project. Listing a path detection skipped - say, a gitignored checkout with
its own `deps.edn` - adds it as a project. Changes apply live; the server
re-resolves without a restart.

The same overrides can live in `.clj-pulse/config.edn` at the workspace root
(see
[clj-pulse configuration](https://github.com/abogoyavlensky/clj-pulse#configuration)),
which works in every editor; where both name the same key, the VS Code
setting wins. To reset everything to the auto-detected defaults, remove the
`clojurePulse.projects` setting - it applies live, no restart needed (a
`.clj-pulse/config.edn` keeps its own say).

To run a REPL inside a subproject, point a `create` configuration's `cwd` at
the subproject's directory - see [REPL](repl.md).

## Linting

Diagnostics come from two tiers. The server's own lints always run and need
nothing installed: unresolved, unused, and duplicate namespace requires,
updated as you type, powering the "Add require" and "Clean namespace"
quickfixes.

Install [clj-kondo](https://github.com/clj-kondo/clj-kondo/blob/master/doc/install.md)
and its full linter set joins them: unresolved symbols, arities, syntax errors,
unused bindings, and the rest. Those findings are marked `clj-kondo` in the
Problems panel, and your `.clj-kondo/config.edn` applies unchanged, so linter
levels and excludes carry over from the command line. When clj-kondo also
reports one of the server's three codes, the server's copy is dropped so
nothing is listed twice. If clj-kondo is missing or fails, the built-in lints
are published exactly as before.

Hover the `clj-pulse` status-bar item to see which tier is live; the tooltip
reads `Linting: clj-kondo + native (v2026.08.04)` or `Linting: native lints
only`.

Two settings control it, both applied live with no restart:

```json
{
  "clojurePulse.kondo.enabled": true,
  "clojurePulse.kondo.path": "clj-kondo"
}
```

`enabled` means "use clj-kondo when it is found", not "require it", so leaving
it on costs nothing when the binary is absent. Set it to `false` to stay on the
built-in lints only.

**Cross-file linters need a `.clj-kondo` directory.** clj-kondo caches the
signatures your project and its dependencies define, and it writes that cache
into a `.clj-kondo` directory it will not create itself. Run `mkdir .clj-kondo`
once per project and `invalid-arity` and `unresolved-var` start working; the
server scans your classpath in the background to fill the cache, showing
"Linting classpath (clj-kondo)" in the status bar while it does.

## ClojureDocs

Put the cursor on a symbol and run **Clojure Pulse: Show ClojureDocs**. The
editor hover opens with the usual arglists and docstring from clj-pulse, and
below them the [ClojureDocs](https://clojuredocs.org) entry: the community
examples, syntax-highlighted in your theme, and the see-also links. The hover
opens focused, so Up and Down scroll it, PageUp and PageDown page through the
examples, and Escape puts the cursor back where it was. Click a see-also link
to load that var's examples in the same hover.

The ordinary hover is unchanged: mouse hovers and `Ctrl+K Ctrl+I` never grow
examples; only the command adds them.

clj-pulse resolves the symbol the same way hover does, so `str/join` finds
`clojure.string/join` through your `ns` form and bare names fall back to
`clojure.core`. ClojureDocs covers `clojure.core` and the other `clojure.*`
namespaces; a project function shows "No ClojureDocs entry".

The data ships inside the extension as `data/clojuredocs.json`, a stripped
copy of the official export that a scheduled workflow refreshes monthly, so
nothing is downloaded and it works offline. It needs clj-pulse 0.4.0 or newer;
an older server gets a message saying so.

Like the eval commands, it ships without a default keybinding. Bind
`clojurePulse.showClojureDocs` in your Keyboard Shortcuts, for example:

```json
{
  "key": "ctrl+alt+d",
  "command": "clojurePulse.showClojureDocs",
  "when": "editorTextFocus && editorLangId == clojure"
}
```

Examples are contributed to ClojureDocs under
[CC0](https://creativecommons.org/publicdomain/zero/1.0/); docstrings come from
Clojure under the EPL. ClojureDocs notes carry no stated license and are not
bundled.
