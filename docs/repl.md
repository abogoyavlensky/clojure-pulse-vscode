# REPL manager and evaluation

[Documentation](README.md) · [Clojure Pulse](../README.md)

The **REPL** view in the Clojure Pulse sidebar lists your project's REPLs. Each
one either starts a server for you or attaches to a server you already have
running. Run as many as you like at once; evaluations go to the **active** one.

## Naming your REPLs

The **+** on the view title opens a form in an editor tab, and so does a
click on any row. The selector at the top chooses the kind and the fields
below it follow, all on one page: the command comes prefilled for the project's
build file, and **Delete** removes the REPL from the same place. Switching the
kind keeps what you typed for the other one. Drag the tab into a floating
window if you would rather keep the form beside your code.

Saving writes to workspace settings, or to your user settings when no folder is
open. `settings.json` stays the source of truth, so you can always edit it by
hand and watch the view follow. An entry that does not validate is skipped,
with the reason in the *Clojure Pulse* output channel - the rest of the list
keeps working.

REPLs live in `clojurePulse.replConfigurations`, in workspace settings, so they
travel with the project:

```json
{
  "clojurePulse.replConfigurations": [
    {
      "name": "dev",
      "type": "create",
      "command": "clojure -Sdeps '{:aliases {:clojure-pulse/nrepl {:extra-deps {nrepl/nrepl {:mvn/version \"1.7.0\"} io.github.tonsky/clj-reload {:mvn/version \"1.0.0\"}} :main-opts [\"-m\" \"nrepl.cmdline\"]}}}' -M:clojure-pulse/nrepl"
    },
    { "name": "local", "type": "connect", "port": ".nrepl-port" },
    { "name": "staging", "type": "connect", "host": "10.0.0.5", "port": 7888 }
  ]
}
```

### `create` - start a server

`command` runs through your shell, verbatim: what the view shows is what runs.
Clojure Pulse reads the port from the server's startup line (or the
`.nrepl-port` file it writes) and connects. There is no startup timeout, so a
first run may take as long as it needs to download dependencies - the output
channel shows the progress, and **Stop** is available throughout.

The command the form prefills follows the build file at the workspace root:
`deps.edn` gets the Clojure CLI one below, `project.clj` gets
`lein repl :headless`, and `lgx.edn` gets `lgx nrepl`.

The Clojure CLI command needs nothing in your `deps.edn`:

```sh
clojure -Sdeps '{:aliases {:clojure-pulse/nrepl {:extra-deps {nrepl/nrepl {:mvn/version "1.7.0"} io.github.tonsky/clj-reload {:mvn/version "1.0.0"}} :main-opts ["-m" "nrepl.cmdline"]}}}' -M:clojure-pulse/nrepl
```

Besides nREPL it injects [clj-reload](https://github.com/tonsky/clj-reload),
which the test commands use to reload what you changed before they run
([Reload before tests](testing.md#reload-before-tests)). Delete that dependency if you do
not want it; everything else keeps working. A Leiningen project adds
`[io.github.tonsky/clj-reload "1.0.0"]` to its `:dev` profile instead, and a
REPL you configured before this version keeps the command you saved until you
add the dependency by hand.

It injects nREPL as an *alias*, so your own aliases compose with it: change the
last argument to `-M:dev:test:clojure-pulse/nrepl` and every alias contributes
its `:extra-deps`, while `:main-opts` (last alias wins) still starts nREPL. The
namespaced alias keeps it separate from common project aliases. The field is yours
either way: any command that starts an nREPL server will do, a `bb` task or a
Makefile target included.

Add `"cwd"` (relative to the workspace root) to run the command somewhere else,
such as a module in a monorepo.

### `connect` - attach to a running server

`host` defaults to `localhost`. `port` is either a number or the path to a file
holding one, relative to the workspace root - `".nrepl-port"` is the file nREPL
writes, so that entry finds whatever port today's server picked.

## Running them

Start and stop from the buttons on each row, or from the Command Palette:
**Start REPL** and **Stop REPL**. The same commands serve both kinds of
configuration: starting a `connect` entry attaches to the running server, and
stopping it disconnects. To bind one REPL to a key, pass its name as the
command argument in `keybindings.json`:

```json
{
  "key": "ctrl+alt+r",
  "command": "clojurePulse.startRepl",
  "args": "dev"
}
```

**Restart REPL** does both halves in one go, and it is how a configuration
edited while a REPL is running takes effect: a live REPL keeps the settings it
started with, and the edit is applied on the way back up. Right-click a running
row for it, or pick *Restart* from the status-bar REPL menu.

Each REPL streams into its own **Output** channel, named `REPL: <name>` - a
real editor buffer with Clojure highlighting, search, and scrollback. The
output icon on a row opens it. A configured REPL keeps its channel across
disconnects and restarts, so the history stays readable; an unsaved host/port
connection is transient, and its channel goes away when it disconnects.

When several REPLs are connected, one is **active** and receives every
evaluation. Connecting a REPL makes it active; **Set Active REPL** (the row
button, or *Switch active REPL* in the status-bar menu) moves the target. Stop
the active REPL and there is no target until you choose one - evaluations warn
rather than land somewhere you did not intend.

## Evaluating

### Evaluate Current Form

With no selection, evaluates the form at the
cursor. It picks the token under (or just before) the cursor, the form that
ends just before the cursor, or the innermost enclosing form - so putting the
cursor right after a closing paren evaluates that whole form. A `#_` discard
is unwrapped so the form itself runs, and the form is evaluated in the file's
namespace (its nearest preceding `ns` form). A non-empty selection is
evaluated as-is.

The highlighted bracket pair is that form's own brackets: Clojure Pulse
replaces VS Code's bracket matcher in Clojure files (it would highlight
`(bar)` in `(foo)|(bar)` where eval sends `(foo)`) by setting
`editor.matchBrackets` to `"never"` for the `clojure` language and drawing
its own highlight in the native colours. Tokens and strings get no highlight,
and neither does anything below an unclosed bracket. To get VS Code's matcher
back, set `"[clojure]": { "editor.matchBrackets": "always" }` in your
settings - the extension's highlight steps aside.

### Evaluate Top Form

Evaluates the top-level form around the cursor from
anywhere inside it, or the one ending just before the cursor, so a `defn`
can be re-evaluated without leaving its body. A `#_` discard is unwrapped
and the form runs in the file's namespace, as above. Inside a `(comment …)`
block, the forms directly under `comment` count as top level, so a rich
comment evaluates one form at a time. The selection is ignored; use
**Evaluate Current Form** to send a selection.

### Select Current Form

Selects exactly what **Evaluate Current Form**
would send, so it doubles as a preview: select, look, then evaluate the
selection.

### Evaluate File

Compiles the whole buffer (unsaved changes included) via
nREPL's `load-file`, so the file's own `ns` form takes effect and stack
traces carry real file/line locations. The run is silent - no output panel
opening on top of your code, no focus lost - with the verdict in the status
bar: the file name with a spinner while it loads, then green on success or a
red background carrying the compile error's first line in its tooltip. Click
it to open the REPL output, which has the full report either way.

### Inline results

By default the value appears at the **end of the line**
in a muted, Cursive-style hint (never wedged between brackets): faint while it
runs, and the error's first line in red on failure. Hover the result for the
full value and a **Copy result** link. The evaluated form flashes briefly so
you can see what was sent. Press **Escape** to hide the results; they also
clear when you edit the evaluated form. **Copy Evaluation Result** copies the
value at the cursor. Turn the
hints off with the `clojurePulse.inlineEvalResults` setting - results still
stream to the REPL's output channel.

### Status bar

`nREPL <name> host:port` at the bottom left names the active
REPL. Click it to show its output, switch the active REPL, add a
configuration, or disconnect. If a server goes away, its REPL returns to
*stopped*, the channel notes the lost connection, and a `create` REPL's
process is cleaned up with it. Tests, file evaluations, and custom REPL
commands share a run indicator beside it. Use **Clojure Pulse: Clear status
bar** in the Command Palette to dismiss its spinner or result. An active run
continues, and its completion stays hidden; the next run shows a new status.
Connection indicators remain visible.

The REPL connection is independent of the `clj-pulse` language server - either
works without the other.

Evaluation commands have no default shortcuts. Use the
[keybinding examples](keybindings.md) to choose your own.

## Custom commands

Save the snippets you send to the REPL all day - `(user/reset)`,
`(user/stop)` - as named commands. The **REPL Commands** view sits between
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
bar shows a spinner while the code runs, then the verdict - the command name
in green (hover for the result value) or on a red background when the
evaluation failed. Click the item to open the REPL output; the transcript
always carries the full exchange. The verdict spot is shared with test
commands and **Evaluate File**: the status bar shows the last run of any kind,
and a newer run replaces it.

The commands live in the `clojurePulse.customReplCommands` setting, saved to
workspace settings when a folder is open:

```json
{
  "clojurePulse.customReplCommands": [
    { "name": "reset", "code": "(user/reset)" }
  ]
}
```

The code is sent to the active REPL exactly as written, in the session's
current namespace, so use fully-qualified symbols as in `(user/reset)`. A
keybinding refers to a command by name; rename the command and the keybinding
needs the new name too.

For test execution and rerunning the last test, see [Testing](testing.md).
