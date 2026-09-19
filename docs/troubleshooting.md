# Troubleshooting

[Documentation](README.md) · [Clojure Pulse](../README.md)

## Language server does not start

Click the **clj-pulse** status item, or run **Clojure Pulse: Show Language
Server Output**. Hover the status item to see which server is selected.

- Use the platform-specific VSIX for the machine running the extension.
  With SSH, WSL, or containers, this is the remote host.
- Leave `clojurePulse.server.path` empty to use the bundled server. A non-empty
  value overrides it, including an old `"clj-pulse"` setting that searches PATH.
- The universal VSIX needs a separate clj-pulse installation. See
  [Getting started](getting-started.md#requirements).

After fixing the path, run **Clojure Pulse: Restart Language Server**.
Set `clojurePulse.trace.server` to `"verbose"` temporarily to inspect LSP traffic.

## Dependencies are missing

Open **External Libraries** and check the project's classpath status. Use
refresh to rescan after adding a subproject or fixing a classpath error.
Only the root project's full classpath is resolved by default; enable each
subproject you need using its play button.

Check that the configured classpath command works in that project's directory.
Include aliases that supply the sources or dependencies you need. For
clj-kondo cross-file diagnostics, create a `.clj-kondo` directory per project.
See [Projects](projects.md#monorepos) and [Linting](projects.md#linting).

## REPL will not connect, or evaluation has no target

Open the REPL's output using its row's output icon. A first startup can take
time to download dependencies; there is no startup timeout. Confirm that the
saved command, working directory, runtime, and build tool are correct.

For a connect configuration, check its host and port. A port-file path is
relative to the workspace root. When several REPLs are running, choose
**Set Active REPL**. Stopping the active REPL leaves no target until you select
another; evaluation is never silently redirected.

Restart a running REPL after editing its configuration to apply the changes.

## Tests run old code

Keep `clojurePulse.test.reloadBeforeRun` at `"clj-reload"` and ensure clj-reload
is on the REPL's classpath. Older saved configurations do not gain this
dependency automatically. Without it, tests run without the reload step.

Reloading does not restart Integrant, Component, or Mount systems. Check your
own reload hooks and configuration if state remains stale. See
[Reload before tests](testing.md#reload-before-tests), including the connection
timing and file-pattern caveats.

## Indentation or shortcuts behave unexpectedly

Check [Parinfer and editor defaults](editing.md#parinfer-and-editor-defaults)
and disable overlapping formatters. Whole-form movement assumes space
indentation; tab-indented lines are left alone. A cljfmt config warning in the
status bar opens the invalid file when clicked.

Evaluation and test commands have no default shortcuts. Add
[personal keybindings](keybindings.md), then use VS Code's Keyboard Shortcuts
editor to inspect conflicts and `when` conditions.

## Reporting a problem

[Open an issue](https://github.com/abogoyavlensky/clojure-pulse-vscode/issues)
with the extension/server versions, OS or remote environment, relevant
settings, a small reproduction, and the relevant output log excerpt. For the
versions, copy the startup line from the Clojure Pulse output channel ("Clojure
Pulse: Show Language Server Output"): it names the extension version, the
server version, and the server path.
