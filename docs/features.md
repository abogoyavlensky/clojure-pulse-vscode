# Features

[Documentation](README.md) · [Clojure Pulse](../README.md)

## Editing

- Syntax highlighting and file associations for `.clj`, `.cljs`, `.cljc`,
  `.edn`, `.bb`, and `.lg`.
- Whole-form movement: move the opening line with Tab or spaces and the body
  follows, preserving relative indentation and hand alignment.
- Indentation on Enter and multiline paste, using cljfmt or structural rules.
- Format Document and Format Selection; optional VS Code format-on-save.
- Bundled cljfmt with the nearest `.cljfmt.edn` or `cljfmt.edn` configuration.
- Bracket highlighting and form selection that match the form evaluation sends.
- Dimming for discarded forms and rich comments; configurable opacity.
- Configurable `;` or `;;` line comments.

[Editing guide](editing.md)

## REPLs and evaluation

- Sidebar REPL manager with forms for creating and editing named configurations.
- Start a local nREPL process or connect to an existing server by host and
  port, including a port read from `.nrepl-port`.
- Run several REPLs, choose the active target, and stop or restart each one.
- Evaluate the current form, selection, top-level form, or whole file.
- Rich-comment and discard-aware form evaluation in the file's namespace.
- Inline values and errors, full-value hover, copying, and per-REPL output.
- Named custom REPL commands, invoked from the sidebar, palette, or a shortcut.
- Connection status and a shared status indicator for evaluations, tests,
  and custom commands.

[REPL guide](repl.md) · [Personal shortcuts](keybindings.md)

## Tests

- Run the test at the cursor or top-level tests in the current namespace.
- Rerun the last test command from another file without moving focus.
- Save and reload changed code before tests when clj-reload is available.
- Pass/fail gutter marks, failure-report hover, inline single-test summaries,
  status-bar verdicts, and full output in the REPL transcript.
- Remove stale gutter results when a marked test changes.

[Testing guide and limitations](testing.md)

## Language intelligence and dependencies

- Fast-starting clj-pulse bundled in platform-specific extension packages.
- Definition navigation, fuzzy/keyword completion, auto-require, hover,
  signature help, references, symbol/keyword rename, outlines, and symbol search.
- Symbol-occurrence highlighting and structural selection expansion.
- Namespace quick fixes, built-in diagnostics, and optional clj-kondo linting.
- Keyword and Integrant-key navigation; JDK interop support.
- External Libraries tree with read-only JAR sources and directory dependencies.
- Navigation, hover, and completion within dependency sources.
- Offline ClojureDocs examples and see-also links, opened with Show ClojureDocs.
- Monorepo discovery, libraries grouped by project, per-project classpath
  controls, custom classpath commands, and project rescanning.

[Navigation and projects guide](projects.md)

## VS Code's Features tab

VS Code builds the installed extension's **Features** tab from
[`package.json`](../package.json) and runtime information. It lists contributed
commands, settings, languages, view containers, and views. The three views are
**REPL**, **REPL Commands**, and **External Libraries**. Their implementation
lives in `src/`; the tab itself belongs to VS Code.

Use [Settings and commands](reference.md) for defaults and command IDs.
