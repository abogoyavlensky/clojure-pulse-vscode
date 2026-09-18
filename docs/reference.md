# Settings and commands

[Documentation](README.md) · [Clojure Pulse](../README.md)

## Settings

Set these in VS Code settings or `settings.json`. Structured REPL, custom-command,
and project settings also have sidebar forms. Defaults below match
[`package.json`](../package.json).

| Setting | Default | Behavior |
| --- | --- | --- |
| `clojurePulse.server.path` | `""` | Empty uses the bundled server, then `clj-pulse` on PATH. Any non-empty value overrides the bundle. A bare name searches PATH; a path is used as given. |
| `clojurePulse.server.args` | `[]` | Extra arguments passed to the language server. |
| `clojurePulse.trace.server` | `"off"` | LSP logging: `off`, `messages`, or `verbose`. |
| `clojurePulse.formatting.engine` | `"cljfmt"` | `cljfmt` or `structural`, used for Enter, paste positioning, Format Document, and Format Selection. [Editing](editing.md#formatting-engines). |
| `clojurePulse.maintainIndentation` | `true` | Keep relative indentation when an edit moves a form. Disable when Parinfer Smart Mode owns this behavior. |
| `clojurePulse.dimIgnoredForms` | `true` | Dim `#_` and `(comment …)` forms. Reload the window after changing. |
| `clojurePulse.dimIgnoredFormsOpacity` | `0.6` | Opacity of dimmed forms, from `0.1` to `1`. Reload the window after changing. |
| `clojurePulse.lineComment` | `";"` | Token inserted by Toggle/Add Line Comment: `;` or `;;`. Applies immediately. |
| `clojurePulse.inlineEvalResults` | `true` | Show values and errors inline. When off, results go to the REPL output channel. |
| `clojurePulse.test.reloadBeforeRun` | `"clj-reload"` | `clj-reload` saves dirty Clojure files and reloads changes when available; `none` skips that step. [Testing](testing.md#reload-before-tests). |
| `clojurePulse.replConfigurations` | `[]` | Named create/connect entries. [REPL configurations](repl.md#naming-your-repls). |
| `clojurePulse.customReplCommands` | `[]` | Named snippets with `name` and `code`. [Custom commands](repl.md#custom-commands). |
| `clojurePulse.projects` | `[]` | Per-project path, classpath-enabled flag, and classpath command overrides. [Monorepos](projects.md#monorepos). |
| `clojurePulse.kondo.enabled` | `true` | Use clj-kondo diagnostics when its binary is available. |
| `clojurePulse.kondo.path` | `"clj-kondo"` | clj-kondo executable name or path. [Linting](projects.md#linting). |

The extension also supplies Clojure editor defaults: `editor.formatOnType`
is `false` because Enter is handled locally, and `editor.matchBrackets` is
`"never"` because the extension highlights the form evaluation would send.
Override editor settings inside a `"[clojure]"` block.

## Commands

Command Palette entries have the **Clojure Pulse:** prefix. Some actions are
intentionally available through sidebar buttons, forms, context menus, or
keybindings instead. The Features tab lists contributed commands even when
hidden from the palette. See [Keybindings](keybindings.md) for examples.

### Language server

| Command | ID | Behavior |
| --- | --- | --- |
| Restart Language Server | `clojurePulse.restart` | Restart the language server. |
| Show Language Server Output | `clojurePulse.showOutput` | Open the language-server log. |

### REPL manager

| Command | ID | Behavior |
| --- | --- | --- |
| Start REPL | `clojurePulse.startRepl` | Start/connect a configuration; optional name in `args`. |
| Stop REPL | `clojurePulse.stopRepl` | Stop/disconnect a configuration; optional name in `args`. |
| Restart REPL | `clojurePulse.restartRepl` | Restart with its saved settings; optional name in `args`. |
| Add REPL Configuration | `clojurePulse.addReplConfig` | Open a new configuration form. |
| Edit REPL Configuration | `clojurePulse.editReplConfig` | Open the selected configuration form. |
| Delete REPL Configuration | `clojurePulse.deleteReplConfig` | Delete a configuration from its form or context menu. |
| Set Active REPL | `clojurePulse.setActiveRepl` | Choose the connection that receives evaluation. |
| Show REPL Output | `clojurePulse.showReplOutput` | Open a REPL transcript. |
| REPL Menu | `clojurePulse.replMenu` | Open the status-bar REPL menu. |

### Evaluation

| Command | ID | Behavior |
| --- | --- | --- |
| Evaluate Current Form | `clojurePulse.evalCurrentForm` | Evaluate the form at the cursor, or the selection. |
| Evaluate Top Form | `clojurePulse.evalTopForm` | Evaluate the enclosing top-level form; respects rich comments. |
| Evaluate File | `clojurePulse.evalFile` | Load the current buffer, including unsaved changes. |
| Select Current Form | `clojurePulse.selectCurrentForm` | Select what Evaluate Current Form would send; bind a key. |
| Copy Evaluation Result | `clojurePulse.copyEvalResult` | Copy the result at the cursor. |

### Testing

| Command | ID | Behavior |
| --- | --- | --- |
| Run Test at Cursor | `clojurePulse.runTestAtCursor` | Run the top-level deftest at the cursor. |
| Run Tests in Namespace | `clojurePulse.runNsTests` | Run the current buffer's top-level deftests. |
| Run Last Test Command | `clojurePulse.rerunLastTest` | Repeat the last cursor or namespace test run without switching files. |

### Status

| Command | ID | Behavior |
| --- | --- | --- |
| Clear status bar | `clojurePulse.clearStatusBar` | Dismiss the shared run indicator; does not cancel the running operation. |

### Custom REPL commands

| Command | ID | Behavior |
| --- | --- | --- |
| Run Custom REPL Command | `clojurePulse.runCustomReplCommand` | Pick a saved command, or pass its name in `args`. |
| Add Custom REPL Command | `clojurePulse.addCustomReplCommand` | Open a new command form. |
| Edit Custom REPL Command | `clojurePulse.editCustomReplCommand` | Edit a saved command. |
| Delete Custom REPL Command | `clojurePulse.deleteCustomReplCommand` | Delete a command from its form or context menu. |

### Libraries and projects

| Command | ID | Behavior |
| --- | --- | --- |
| Refresh External Libraries | `clojurePulse.refreshExternalLibraries` | Rescan projects and re-resolve enabled classpaths; older servers only refresh the tree. |
| Enable Classpath Resolution | `clojurePulse.enableProjectClasspath` | Enable resolution for the selected project. |
| Disable Classpath Resolution | `clojurePulse.disableProjectClasspath` | Disable resolution for the selected project. |
| Add Project | `clojurePulse.addProject` | Open a project form from the view's + button. |
| Edit Project | `clojurePulse.editProject` | Edit a project's classpath settings. |

### Documentation

| Command | ID | Behavior |
| --- | --- | --- |
| Show ClojureDocs | `clojurePulse.showClojureDocs` | Open community examples for the current symbol in a focused hover. |

### Editor bindings

`clojurePulse.newline` handles Enter; `clojurePulse.clearInlineResults` handles
Escape while inline results are visible. Both defer to relevant editor widgets
and are omitted from the Command Palette. `clojurePulse.openCljfmtConfig` is an
internal action used by the invalid-config status indicator.
