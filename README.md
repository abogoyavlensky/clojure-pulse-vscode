# Clojure Pulse

<img src="https://raw.githubusercontent.com/abogoyavlensky/clojure-pulse-vscode/master/docs/images/icon.png" alt="Clojure Pulse icon" width="128" />

A lightweight, powerful VS Code extension for Clojure and
[let-go](https://github.com/nooga/let-go), powered by the
[clj-pulse](https://github.com/abogoyavlensky/clj-pulse) language server.

Clojure Pulse is self-contained: it ships its own Clojure syntax highlighting
and file associations, then connects to `clj-pulse` for the IDE features. You
do not need any other Clojure extension.

> **Status:** early-stage and under active development. Expect the occasional
> rough edge, and please file [issues](https://github.com/abogoyavlensky/clojure-pulse-vscode/issues).

## Features

- **Syntax highlighting** and bracket/comment editing for `.clj`, `.cljs`,
  `.cljc`, `.edn`, `.bb`, and `.lg` files.
- **Language intelligence** from `clj-pulse`:
  - Go to definition — project files, JAR libraries, git/`:local/root` deps,
    and `clojure.core`.
  - Autocomplete, hover, and signature help.
  - Find references and rename across the project.
  - Document symbols (outline) and workspace symbol search.
  - Code actions, including "Add require", and live diagnostics.
  - Keyword and Integrant-key navigation, and built-in Java interop.
- **Library navigation** — jumping into a `jar:` source (a dependency or
  `clojure.core`) opens the real file, read-only.
- **External Libraries panel** — a Cursive-style tree, in its own activity-bar
  container, lists every dependency `clj-pulse` resolved for the project:
  deps.edn's full transitive classpath, an lgx project's git/`:local/root`
  deps, or a Leiningen project's direct dependencies (best effort — Leiningen
  resolution is direct-deps-only). Expand a library to browse its contents —
  jar entries open read-only via the same `jar:` provider, and directory-based
  deps are browsed straight from disk. The panel refreshes itself whenever the
  classpath is re-indexed, and a refresh button is on the view title. If
  nothing is resolved yet, the empty state tells you how to generate a
  classpath for your project type (e.g. `clojure -Spath` for deps.edn). In a
  multi-project workspace the tree is grouped by project, with a per-project
  classpath toggle — see [Monorepos](#monorepos).
- **Indent on Enter** — pressing Enter indents the new line to the
  structurally correct column (vectors/maps align to the first element,
  symbol-headed lists get a 2-space body). Handled client-side: the extension
  owns the Enter key for Clojure and inserts newline + indent as one atomic
  edit, so the cursor lands exactly right with no visible hop. clj-pulse still
  serves `textDocument/onTypeFormatting` for other editors; the extension sets
  `editor.formatOnType` to `false` for Clojure so the two never both fire.
  Enter falls through to VS Code whenever a suggest widget, snippet, rename
  box, or code-action menu is active.
- **Maintained relative indentation** (Cursive-style) — when an edit moves
  code that later lines of a multiline form are anchored to, those lines
  follow automatically: add spaces before `(defn`, press Enter right before a
  form, or rename `->` to `cond->` in an argument-aligned thread, and the
  body lines shift by the same amount. It only *translates* lines (never
  reformats them), merges into the same undo step as your keystroke, and
  stays away from multiline strings, tab-indented lines, unbalanced forms,
  and multi-cursor edits.
- **Status bar indicator** — the server's state (starting, running, stopped,
  error) shows at the bottom left; click it to open the server log.
- **REPL manager** — name your project's REPLs in a form, start them (or
  connect to running ones) from the sidebar, and evaluate code from the editor.
  Several REPLs can run at once. See [REPL](#repl) below.
- **Custom REPL commands** — save the snippets you send to the REPL all day
  (`(user/reset)`, `(user/stop)`) as named commands, and run them from the
  sidebar, the palette, or your own keybindings. See
  [Custom commands](#custom-commands) below.

The available language features track whatever your installed `clj-pulse`
version supports — see the [clj-pulse README](https://github.com/abogoyavlensky/clj-pulse#features).

## Installation

Until the extension reaches the VS Code Marketplace, install it from
[GitHub Releases](https://github.com/abogoyavlensky/clojure-pulse-vscode/releases/latest):

1. Download `clojure-pulse-<version>.vsix` from the latest release.
2. Install it from the command line (requires the `code` command on your `PATH`):

   ```sh
   code --install-extension clojure-pulse-<version>.vsix
   ```

   Or from the UI: Extensions view → **⋯** → **Install from VSIX…**.

3. Reload VS Code.

Then install the `clj-pulse` server (next section) to get the language
features.

## Requirements

Install the `clj-pulse` server and make sure it is on your `PATH`.

```sh
# Homebrew (macOS, Linux)
brew install abogoyavlensky/tap/clj-pulse

# or mise (macOS, Linux)
mise use -g ubi:abogoyavlensky/clj-pulse
```

You can also download a binary from the
[clj-pulse releases](https://github.com/abogoyavlensky/clj-pulse/releases) and
place it on your `PATH`. To confirm the install:

```sh
clj-pulse --version
```

## Configuration

By default the extension runs `clj-pulse` from your `PATH`. Override the
location or pass extra arguments in your `settings.json`:

```json
{
  "clojurePulse.server.path": "/absolute/path/to/clj-pulse",
  "clojurePulse.server.args": [],
  "clojurePulse.trace.server": "off"
}
```

| Setting | Default | Description |
| --- | --- | --- |
| `clojurePulse.server.path` | `"clj-pulse"` | Path to the server binary. A bare name is resolved from `PATH`; an absolute or relative path is used as-is. |
| `clojurePulse.server.args` | `[]` | Extra arguments passed to the server on startup. |
| `clojurePulse.trace.server` | `"off"` | Logs LSP traffic to the output channel (`off`, `messages`, or `verbose`). |
| `clojurePulse.maintainIndentation` | `true` | Keep relative indentation while editing (shift a form's following lines when its anchor moves). |
| `clojurePulse.replConfigurations` | `[]` | The REPLs listed in the sidebar — see [REPL](#repl). |
| `clojurePulse.projects` | `[]` | Per-project classpath overrides for multi-project workspaces — see [Monorepos](#monorepos). |

**Using Parinfer?** Parinfer's Smart Mode maintains indentation itself — running
both would shift lines twice, so set `clojurePulse.maintainIndentation: false`
(or disable Parinfer for Clojure). Parinfer's Indent Mode is complementary:
Clojure Pulse indents and shifts, Parinfer places brackets. If you prefer
Parinfer (or anything else) to drive the Enter key, remove or rebind the
`clojurePulse.newline` keybinding in your Keyboard Shortcuts.

## Monorepos

A workspace holding several Clojure projects — a root plus `apps/backend`,
`libs/common`, and so on — needs no configuration. clj-pulse detects every
directory with a `deps.edn`, `project.clj`, or `lgx.edn` (up to four levels
deep, honoring `.gitignore`), indexes each project's sources, and picks up
whatever classpath its `.cpcache` already holds. Navigation and rename work
across the whole workspace.

In a multi-project workspace the External Libraries panel groups its tree by
project: each row names the project, its build tool, and its classpath
status, with the resolved libraries underneath.

Resolving a project's *full* classpath — aliases included — runs its
classpath command (`clojure -A:dev:test -Spath` for deps.edn projects,
`lein classpath` for Leiningen; lgx projects resolve internally, without a
command). The first run may download dependencies, so only the root project
runs it by default. To enable it for a subproject, click the play button on
the project's row (the stop button disables it again). The button writes the
`clojurePulse.projects` setting in workspace settings; the panel follows the
setting, so editing `settings.json` by hand works too:

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
project. Listing a path detection skipped — say, a gitignored checkout with
its own `deps.edn` — adds it as a project. Changes apply live; the server
re-resolves without a restart.

The same overrides can live in `.clj-pulse/config.edn` at the workspace root
(see
[clj-pulse configuration](https://github.com/abogoyavlensky/clj-pulse#configuration)),
which works in every editor; where both name the same key, the VS Code
setting wins.

To run a REPL inside a subproject, point a `create` configuration's `cwd` at
the subproject's directory — see [REPL](#repl).

## REPL

The **REPL** view in the Clojure Pulse sidebar lists your project's REPLs. Each
one either starts a server for you or attaches to a server you already have
running. Run as many as you like at once; evaluations go to the **active** one.

### Naming your REPLs

REPLs live in `clojurePulse.replConfigurations`, in workspace settings, so they
travel with the project:

```json
{
  "clojurePulse.replConfigurations": [
    {
      "name": "dev",
      "type": "create",
      "command": "clojure -Sdeps '{:aliases {:clojure-pulse/nrepl {:extra-deps {nrepl/nrepl {:mvn/version \"1.7.0\"}} :main-opts [\"-m\" \"nrepl.cmdline\"]}}}' -M:clojure-pulse/nrepl"
    },
    { "name": "local", "type": "connect", "port": ".nrepl-port" },
    { "name": "staging", "type": "connect", "host": "10.0.0.5", "port": 7888 }
  ]
}
```

The **+** on the view title opens a form in an editor tab, and so does the
pencil on any row. The selector at the top chooses the kind and the fields
below it follow, all on one page: the command comes prefilled for the project's
build file, and **Delete** removes the REPL from the same place. Switching the
kind keeps what you typed for the other one. Drag the tab into a floating
window if you would rather keep the form beside your code.

Saving writes to workspace settings, or to your user settings when no folder is
open. `settings.json` stays the source of truth, so you can always edit it by
hand and watch the view follow. An entry that does not validate is skipped,
with the reason in the *Clojure Pulse* output channel — the rest of the list
keeps working.

#### `create` — start a server

`command` runs through your shell, verbatim: what the view shows is what runs.
Clojure Pulse reads the port from the server's startup line (or the
`.nrepl-port` file it writes) and connects. There is no startup timeout, so a
first run may take as long as it needs to download dependencies — the output
channel shows the progress, and **Stop** is available throughout.

The command the form prefills follows the build file at the workspace root:
`deps.edn` gets the Clojure CLI one below, `project.clj` gets
`lein repl :headless`, and `lgx.edn` gets `lgx nrepl`.

The Clojure CLI command needs nothing in your `deps.edn`:

```sh
clojure -Sdeps '{:aliases {:clojure-pulse/nrepl {:extra-deps {nrepl/nrepl {:mvn/version "1.7.0"}} :main-opts ["-m" "nrepl.cmdline"]}}}' -M:clojure-pulse/nrepl
```

It injects nREPL as an *alias*, so your own aliases compose with it: change the
last argument to `-M:dev:test:clojure-pulse/nrepl` and every alias contributes
its `:extra-deps`, while `:main-opts` (last alias wins) still starts nREPL. The
namespaced name cannot collide with an alias of your own. The field is yours
either way: any command that starts an nREPL server will do, a `bb` task or a
Makefile target included.

Add `"cwd"` (relative to the workspace root) to run the command somewhere else,
such as a module in a monorepo.

#### `connect` — attach to a running server

`host` defaults to `localhost`. `port` is either a number or the path to a file
holding one, relative to the workspace root — `".nrepl-port"` is the file nREPL
writes, so that entry finds whatever port today's server picked.

### Running them

Start and stop from the buttons on each row, or from the Command Palette:
**Start REPL**, **Stop REPL**, **Connect to Running nREPL**. To bind one REPL to
a key, pass its name as the command argument in `keybindings.json`:

```json
{
  "key": "ctrl+alt+r",
  "command": "clojurePulse.startRepl",
  "args": "dev"
}
```

Each REPL streams into its own **Output** channel, named `REPL: <name>` — a
real editor buffer with Clojure highlighting, search, and scrollback. Click a
row to open it. A configured REPL keeps its channel across disconnects and
restarts, so the history stays readable; an unsaved host/port connection is
transient, and its channel goes away when it disconnects.

When several REPLs are connected, one is **active** and receives every
evaluation. Connecting a REPL makes it active; **Set Active REPL** (the row
button, or *Switch active REPL* in the status-bar menu) moves the target. Stop
the active REPL and there is no target until you choose one — evaluations warn
rather than land somewhere you did not intend.

### Evaluating

- **Evaluate Current Form** — with no selection, evaluates the form at the
  cursor. It picks the token under (or just before) the cursor, the form that
  ends just before the cursor, or the innermost enclosing form — so putting the
  cursor right after a closing paren evaluates that whole form. A `#_` discard
  is unwrapped so the form itself runs, and the form is evaluated in the file's
  namespace (its nearest preceding `ns` form). A non-empty selection is
  evaluated as-is.
- **Evaluate File** — compiles the whole buffer (unsaved changes included) via
  nREPL's `load-file`, so the file's own `ns` form takes effect and stack
  traces carry real file/line locations.
- **Evaluate Selection** — evaluate exactly the selected code.
- **Run Test at Cursor** — with the cursor inside a top-level `deftest` (or
  right after its closing paren), re-evaluates the test in the file's namespace
  so the buffer's current version is what runs, then executes it via
  `clojure.test`. If the namespace isn't loaded yet, the file is loaded
  automatically first — no manual **Evaluate File** needed. The summary map
  (`{:test 1, :pass 2, :fail 0, …}`) appears inline on the form; the full
  report streams to the REPL's output channel without moving focus there
  (when inline results are off, the channel is shown up front, as for every
  eval command). The gutter marks the deftest with a green check circle on
  pass or a red cross circle on fail — hover the deftest's first line for the
  failure report — and the status bar shows the verdict at a glance: the test
  name in green when it passed, on a red background with fail/error counts
  when it didn't; click it to open the REPL output. Marks always show the
  result of the **last test command** only: a new run wipes the previous
  report, and an edit to a marked deftest removes its (now stale) gutter
  verdict. The status bar's verdict spot is shared with custom REPL commands —
  it shows the last run of either kind, so a newer run replaces what is on
  display (the gutter marks keep the test report either way). Works against JVM Clojure (1.11+) and
  let-go REPLs — with one let-go caveat: until let-go gains `run-test-var`, a
  single-test run there calls the test function directly, skipping
  `use-fixtures` fixtures.
- **Run Tests in Namespace** — runs every top-level `deftest` in the current
  buffer. The buffer is loaded first (as **Evaluate File** does), so helpers
  and tests are refreshed and what runs is exactly what you see; then each
  test runs in turn, and its gutter mark appears as it finishes. A failing
  test does not stop the run. The status bar shows the namespace name — a
  spinner while it runs, then green on pass, or a red background with the
  summed fail/error counts. Results live in the gutter and the REPL's output
  channel: bulk runs paint no inline decorations, so an error that aborts the
  run (a file that doesn't compile) is reported as a notification. Two
  deliberate limits: a discarded `#_(deftest …)` is skipped (discarding a
  test is how you disable it, and the load never defines it), as is one
  wrapped in a reader conditional (`#?(:clj (deftest …))`); and because each
  test runs on its own, `:once` fixtures run once *per test*, not once per
  namespace (and on a let-go without `run-test-var`, the same fallback the
  single-test command uses skips fixtures entirely).
- **Run Last Test Command** — repeats whatever test command ran last, from
  anywhere. The Cursive workflow this copies: run a `deftest`, switch to the
  business-logic code, change something, eval it in the REPL — then re-run the
  test without ever leaving the file you're in. The command re-reads the test
  file's current content (unsaved edits included), finds the test again by
  namespace and name — so it survives the deftest moving around the file — and
  runs it exactly as the original command would: same gutter marks on the test
  file, same status-bar verdict. Focus stays where you are; the test file is
  never opened or revealed. If the recorded test has since been renamed or
  deleted, a status-bar message says so instead of guessing.
- **Inline results** — by default the value appears at the **end of the line**
  in a muted, Cursive-style hint (never wedged between brackets): faint while it
  runs, and the error's first line in red on failure. Hover the result for the
  full value and a **Copy result** link. The evaluated form flashes briefly so
  you can see what was sent. Press **Escape** to hide the results; they also
  clear when you edit the evaluated form. **Clear Inline Results** removes them
  all, and **Copy Evaluation Result** copies the value at the cursor. Turn the
  hints off with the `clojurePulse.inlineEvalResults` setting — results still
  stream to the REPL's output channel.
- **Status bar** — `nREPL <name> host:port` at the bottom left names the active
  REPL. Click it to show its output, switch the active REPL, add a
  configuration, or disconnect. If a server goes away, its REPL returns to
  *stopped*, the channel notes the lost connection, and a `create` REPL's
  process is cleaned up with it.

The REPL connection is independent of the `clj-pulse` language server — either
works without the other.

The eval commands ship without default keybindings. Bind the ones you use, for
example in `keybindings.json`:

```json
{
  "key": "cmd+enter",
  "command": "clojurePulse.evalCurrentForm",
  "when": "editorTextFocus && editorLangId == clojure"
}
```

### Custom commands

Save the snippets you send to the REPL all day — `(user/reset)`,
`(user/stop)` — as named commands. The **REPL Commands** view sits between
the REPL and External Libraries panes; the **+** on its title opens the same
kind of editor-tab form the REPL manager uses, with a name and the code to
run. Clicking a row opens that form; the play button on the row runs the
command. The palette's **Run Custom REPL Command** picks one by name, and a
keybinding runs one directly:

```json
{
  "key": "ctrl+alt+r",
  "command": "clojurePulse.runCustomReplCommand",
  "args": "reset"
}
```

A run is silent: no output panel stealing space, no notifications. The status
bar shows a spinner while the code runs, then the verdict — the command name
in green (hover for the result value) or on a red background when the
evaluation failed. Click the item to open the REPL output; the transcript
always carries the full exchange. The verdict spot is shared with test
commands: the status bar shows the last run of either kind, and a newer run
replaces it.

The commands live in the `clojurePulse.customReplCommands` setting, saved to
workspace settings when a folder is open:

```json
[
  { "name": "reset", "code": "(user/reset)" }
]
```

The code is sent to the active REPL exactly as written, in the session's
current namespace, so use fully-qualified symbols as in `(user/reset)`. A
keybinding refers to a command by name; rename the command and the keybinding
needs the new name too.

## Commands

Run these from the Command Palette:

- **Clojure Pulse: Restart Server** — restart the language server.
- **Clojure Pulse: Show Output** — open the server output channel.
- **Clojure Pulse: Refresh External Libraries** — reload the External Libraries
  tree (also available as a button on the view title).
- **Clojure Pulse: Start REPL** — bring up a configured REPL. Takes a name as
  its argument, so a keybinding can start one directly. With nothing configured
  yet, it opens the form instead.
- **Clojure Pulse: Stop REPL** — stop a running REPL, killing the server it
  started.
- **Clojure Pulse: Connect to Running nREPL** — connect one of the configured
  `connect` REPLs, offering to add one when none is configured yet.
- **Clojure Pulse: Disconnect from nREPL** — disconnect the active REPL.
- **Clojure Pulse: Add REPL Configuration** — open the form for a new REPL
  (also the **+** on the REPL view).
- **Clojure Pulse: Edit REPL Configuration** — open the form on an existing
  REPL (also the pencil on its row).
- **Clojure Pulse: Delete REPL Configuration** — remove an entry, as the form's
  **Delete** button does.
- **Clojure Pulse: Set Active REPL** — choose which REPL evaluations go to.
- **Clojure Pulse: Show REPL Output** — open a REPL's output channel.
- **Clojure Pulse: Evaluate Current Form** — evaluate the form at the cursor
  (or the selection) in the active REPL.
- **Clojure Pulse: Evaluate File** — load the whole current file into the REPL.
- **Clojure Pulse: Evaluate Selection** — evaluate the selected code in the
  active REPL.
- **Clojure Pulse: Run Test at Cursor** — re-evaluate and run the `deftest`
  under the cursor in the active REPL, loading the file's namespace first if
  needed.
- **Clojure Pulse: Run Tests in Namespace** — load the current file and run
  every top-level `deftest` in it, one after another.
- **Clojure Pulse: Run Last Test Command** — repeat the last test command
  (either of the two above) without switching to the test file.
- **Clojure Pulse: Clear Inline Results** — remove all inline result decorations.
- **Clojure Pulse: Copy Evaluation Result** — copy the value of the result at
  the cursor.
- **Clojure Pulse: Run Custom REPL Command** — run a saved command in the
  active REPL. Takes a name as its argument, so a keybinding can run one
  directly; with nothing configured yet, it opens the form instead.
- **Clojure Pulse: Add Custom REPL Command** — open the form for a new command
  (also the **+** on the REPL Commands view).
- **Clojure Pulse: Edit Custom REPL Command** — open the form on an existing
  command (also a click on its row).
- **Clojure Pulse: Delete Custom REPL Command** — remove a command, as the
  form's **Delete** button does.

## Using it on its own

Clojure Pulse contributes the `clojure` language itself. If you also have Calva
(or another extension that registers the `clojure` language) installed, disable
it to avoid a duplicate language registration — Clojure Pulse is meant to stand
on its own.

## Development

### Setup

The toolchain is pinned with [mise](https://mise.jdx.dev/) (see `.mise.toml`):
Node.js plus the `clj-pulse` server for end-to-end testing. With mise installed,
from a fresh clone:

```sh
make setup       # mise install (Node + clj-pulse) + npm install
```

On Linux the test suite launches a real VS Code, which needs a virtual display —
install `xvfb` (`sudo apt-get install -y xvfb`). macOS needs nothing extra.

### Tasks

Run `make` to list every task:

| Command | Description |
| --- | --- |
| `make compile` | Type-check and bundle the extension |
| `make watch` | Rebuild the bundle on change |
| `make lint` | Run ESLint |
| `make test` | Run the test suite (uses `xvfb` on Linux) |
| `make check` | Lint, compile, and test |
| `make package` | Build the installable `.vsix` |
| `make install-extension` | Build the `.vsix` and install it into VS Code |

Press <kbd>F5</kbd> in VS Code to launch an Extension Development Host with the
extension loaded.

### Install it on your own projects

To run Clojure Pulse day-to-day from source — like a Marketplace install, but
local — build and install the `.vsix` (requires the `code` command on your
`PATH`):

```sh
make install-extension
```

That runs `code --install-extension clojure-pulse-<version>.vsix --force`. You
can also install it from the UI: Extensions view → **⋯** → **Install from
VSIX…**. Reload VS Code afterwards, and rerun the command to update after
changes (bump `version` in `package.json` for clean version tracking).

## License

[MIT](LICENSE). Copyright (c) 2026 Andrey Bogoyavlenskiy.
