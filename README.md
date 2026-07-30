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
  classpath for your project type (e.g. `clojure -Spath` for deps.edn).
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

The available language features track whatever your installed `clj-pulse`
version supports — see the [clj-pulse README](https://github.com/abogoyavlensky/clj-pulse#features).

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

**Using Parinfer?** Parinfer's Smart Mode maintains indentation itself — running
both would shift lines twice, so set `clojurePulse.maintainIndentation: false`
(or disable Parinfer for Clojure). Parinfer's Indent Mode is complementary:
Clojure Pulse indents and shifts, Parinfer places brackets. If you prefer
Parinfer (or anything else) to drive the Enter key, remove or rebind the
`clojurePulse.newline` keybinding in your Keyboard Shortcuts.

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

## Commands

Run these from the Command Palette:

- **Clojure Pulse: Restart Server** — restart the language server.
- **Clojure Pulse: Show Output** — open the server output channel.
- **Clojure Pulse: Refresh External Libraries** — reload the External Libraries
  tree (also available as a button on the view title).
- **Clojure Pulse: Start REPL** — bring up a configured REPL. Takes a name as
  its argument, so a keybinding can start one directly.
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
- **Clojure Pulse: Clear Inline Results** — remove all inline result decorations.
- **Clojure Pulse: Copy Evaluation Result** — copy the value of the result at
  the cursor.

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
