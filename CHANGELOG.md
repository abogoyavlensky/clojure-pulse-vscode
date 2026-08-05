# Changelog

All notable changes to the Clojure Pulse extension are documented in this file.

## [Unreleased]

- **Run Test at Cursor**: a command that runs the top-level `deftest` under
  (or right after) the cursor in the active REPL. It re-evaluates the test
  first so the buffer's current version runs, and shows the clojure.test
  summary inline on the form; the full report streams to the REPL's output
  channel without moving focus there (with inline results off, the channel is
  shown up front, as for every eval command). A status-bar item shows the
  last run at a glance — a spinner while it runs, the test name in green on
  pass, a red background with fail/error counts on failure — and clicking it
  opens the REPL output.
  A namespace that isn't loaded yet is loaded automatically (the whole file,
  as **Evaluate File** would). Works on JVM Clojure 1.11+ and let-go REPLs —
  on let-go the runner falls back to calling the test function directly with
  `test`-ns counter accounting, since `run-test-var` doesn't exist there yet
  (this bypasses `use-fixtures` fixtures on let-go until then). Cursive-style
  gutter marks show the verdict on the deftest itself — a green check circle
  on pass, a red cross circle on fail with the failure report on hover over
  the deftest line. The gutter always reflects the last test command only:
  each run replaces the previous report, and editing a marked deftest clears
  its stale verdict.
- **Run Tests in Namespace**: a command that runs every top-level `deftest` in
  the current buffer. The buffer is loaded first (as **Evaluate File** does),
  so what runs is what you see; then each test runs in turn and paints its own
  gutter mark as it finishes, a failing one not stopping the rest. The status
  bar carries the namespace's aggregate verdict with the summed fail/error
  counts. Bulk runs paint no inline decorations — results live in the gutter
  and the REPL's output channel — so an error that aborts the run is reported
  as a notification. Discarded (`#_(deftest …)`) and reader-conditional
  deftests are skipped, and `:once` fixtures run once per test rather than
  once per namespace, since each test runs on its own — or not at all on a
  let-go without `run-test-var`, whose fallback runner bypasses fixtures.
- **Run Last Test Command**: repeats whatever test command ran last — a single
  `deftest` or a whole namespace — without switching to the test file, so the
  edit-eval-retest loop never leaves the business-logic buffer. The test is
  found again by namespace and name in the file's current content, and the run
  reports exactly as the original command did: gutter marks on the test file
  and the verdict in the status bar. A test that was renamed or deleted since
  is reported in the status bar rather than guessed at.
- **REPL configuration form**: **Add REPL Configuration** and **Edit REPL
  Configuration** both open a form in an editor tab instead of prompting, so
  the entry's fields are all on one page — including the long `create`
  command, which now has room. Edit is an inline pencil on every row, not just
  a context-menu entry, and the form carries its own **Delete**. The command
  comes prefilled for the project's build file: the Clojure CLI one for
  `deps.edn`, `lein repl :headless` for `project.clj`, `lgx nrepl` for
  `lgx.edn`. Saving writes to workspace settings, or to user settings when no
  folder is open, and preserves entries it did not touch. Drag the tab into a
  floating window to keep the form beside your code. **Start REPL** opens the
  form too when no REPL is configured yet, rather than reporting that every
  configured REPL is already running.
- **Removed unsaved ad-hoc connections.** **Connect to Running nREPL** used to
  offer a *Connect to host:port…* entry that connected without saving anything;
  it now lists the configured `connect` REPLs, and offers to add one when there
  are none. Every row in the REPL view is a configuration.
- **REPL manager**: a **REPL** view in the Clojure Pulse sidebar listing the
  REPLs named in the new `clojurePulse.replConfigurations` workspace setting.
  An entry either starts a server (`"type": "create"` — a plain command line,
  prefilled to inject nREPL through a namespaced `-Sdeps` alias, so no
  `deps.edn` change is needed) or attaches to one already running
  (`"type": "connect"`, with a port number or a port file such as
  `".nrepl-port"`). Ports are discovered from the server's startup line, with
  no startup timeout, so a first run can download dependencies for as long as
  it needs. Stopping a REPL kills the whole process group it started, as does
  shutting the extension down. Added **Start REPL**, **Stop REPL**, **Add /
  Edit / Delete REPL Configuration**, **Set Active REPL**, and **Show REPL
  Output** commands. The ones that act on a REPL — start, stop, connect,
  delete, set active, show output — take its name, so a keybinding can drive a
  single REPL (`"args": "dev"`).
- **Several REPLs at once**, with one **active** REPL receiving evaluations.
  Connecting a REPL makes it active; stopping it leaves no target rather than
  silently moving evaluations elsewhere. The status bar names the active REPL
  and its menu can switch between the connected ones.
- **REPL output moved to the Output panel**: each REPL streams into its own
  `REPL: <name>` channel, created with the `clojure` language id — highlighting,
  search, and scrollback come from the editor itself. This **replaces the REPL
  webview pane** in the bottom panel, which has been removed.
- **External Libraries panel**: a tree view in a new activity-bar container
  (pulse icon) listing the dependencies `clj-pulse` resolved for the project
  (deps.edn transitive classpath, lgx deps, or Leiningen direct deps). Expand a
  library to browse its files — jar entries open read-only, directory deps are
  read from disk. Refreshes on classpath re-indexing (via the
  `clojurePulse/librariesChanged` server notification) and via a
  **Refresh External Libraries** command / view-title button.
- nREPL support: **Connect to Running nREPL**, **Evaluate Selection**, and
  **Disconnect** commands; a transcript of connection banners, evaluated forms,
  values, and stdout/stderr; and an nREPL status bar item with a connect / show
  / disconnect menu.
- **Evaluate Current Form** (form at the cursor, evaluated in the file's
  namespace) and **Evaluate File** (whole buffer via nREPL `load-file`)
  commands.
- **Inline evaluation results**: the value appears at the end of the line in a
  muted, Cursive-style hint (never between brackets) — faint while running, red
  on error — with the full value and a Copy link on hover, and a brief flash of
  the evaluated form. Press **Escape** to hide the results (they also clear when
  you edit the form). Added **Clear Inline Results** and **Copy Evaluation
  Result** commands and the `clojurePulse.inlineEvalResults` setting (default
  on) to toggle the hints.

## [0.0.1]

Initial release.

- Self-contained Clojure language contribution: syntax highlighting and
  bracket/comment editing for `.clj`, `.cljs`, `.cljc`, `.edn`, `.bb`, and
  `.lg` files.
- Language client for the `clj-pulse` server, resolved from
  `clojurePulse.server.path` or the `PATH`, with `Restart Server` and
  `Show Output` commands.
- `jar:` content provider so go-to-definition opens library and `clojure.core`
  sources.
- Status-bar indicator reflecting the server lifecycle.
