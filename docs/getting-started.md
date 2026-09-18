# Getting started

[Documentation](README.md) · [Clojure Pulse](../README.md)

## Install

Until the extension reaches the VS Code Marketplace, install it from
[GitHub Releases](https://github.com/abogoyavlensky/clojure-pulse-vscode/releases/latest).
Each release has one `.vsix` per platform, with the `clj-pulse` server
inside, plus a universal one without it:

| File | Platform |
| --- | --- |
| `clojure-pulse-darwin-arm64-<version>.vsix` | macOS, Apple Silicon |
| `clojure-pulse-darwin-x64-<version>.vsix` | macOS, Intel |
| `clojure-pulse-linux-x64-<version>.vsix` | Linux, x86-64 |
| `clojure-pulse-linux-arm64-<version>.vsix` | Linux, ARM64 |
| `clojure-pulse-win32-x64-<version>.vsix` | Windows, x86-64 |
| `clojure-pulse-<version>.vsix` | Universal: any platform, `clj-pulse` from your `PATH` |

1. Download the `.vsix` for your platform. It includes `clj-pulse`; no separate language-server installation is needed.
2. Install it from the command line (requires the `code` command on your `PATH`):

   ```sh
   code --install-extension clojure-pulse-<platform>-<version>.vsix
   ```

   Or from the UI: Extensions view → **⋯** → **Install from VSIX…**.

3. Reload VS Code.

## Requirements

VS Code 1.97 or newer. Platform builds include the language server.
To start a REPL or resolve project dependencies, also install your project's
runtime and build tool: the JDK and Clojure CLI, Leiningen, or let-go/lgx.

**Remote hosts.** The extension runs where your files are, so under
Remote-SSH, WSL or a dev container it runs on the remote host. Install the
`.vsix` that matches the *remote* machine's platform there: while connected,
Extensions view → **⋯** → **Install from VSIX…**.

**Universal build.** The universal `.vsix` runs `clj-pulse` from your `PATH`
(or the path in `clojurePulse.server.path`), so install the server yourself:

```sh
# Homebrew (macOS, Linux)
brew install abogoyavlensky/tap/clj-pulse

# or mise (macOS, Linux)
mise use -g github:abogoyavlensky/clj-pulse
```

You can also download a binary from the
[clj-pulse releases](https://github.com/abogoyavlensky/clj-pulse/releases) and
place it on your `PATH`. To confirm the install:

```sh
clj-pulse --version
```

## First evaluation

1. Open your project folder, then a Clojure file. Navigation and completion
   use the language server and do not need a REPL connection.
2. Open **Clojure Pulse** in the activity bar. In **REPL**, click **+**, name
   the configuration `dev`, and choose **create**. Review the prefilled
   command for your build tool, add any project aliases, and save.
3. Click the play button on `dev`. Its output shows startup progress. The
   status bar names the active REPL when it connects.
4. In your file, add `(comment (+ 20 22))`. Put the cursor immediately after
   `(+ 20 22)` and run **Clojure Pulse: Evaluate Current Form** from the
   Command Palette. The inline result is `42`.
5. Add [your own shortcuts](keybindings.md) for the actions you use.

Already have an nREPL server? Choose **connect** instead, then enter its host
and port or `.nrepl-port` file. See [REPL configurations](repl.md).

## Other Clojure extensions

Clojure Pulse supplies its own language registration, syntax highlighting,
formatting, and language client. Disable overlapping Clojure extensions in
this workspace if they compete for formatting, highlighting, or REPL commands.

If something does not start, see [Troubleshooting](troubleshooting.md).
