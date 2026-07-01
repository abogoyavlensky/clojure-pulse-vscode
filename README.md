# Clojure Pulse

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
- **Status bar indicator** — the server's state (starting, running, stopped,
  error) shows at the bottom left; click it to open the server log.

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

## Commands

Run these from the Command Palette:

- **Clojure Pulse: Restart Server** — restart the language server.
- **Clojure Pulse: Show Output** — open the server output channel.

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
