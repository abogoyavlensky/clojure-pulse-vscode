# Development

[Documentation](README.md) · [Clojure Pulse](../README.md)

## Setup

The toolchain is pinned with [mise](https://mise.jdx.dev/) (see `.mise.toml`):
Node.js plus the `clj-pulse` server for end-to-end testing. With mise installed,
from a fresh clone:

```sh
make setup       # mise install (Node + clj-pulse) + npm install
```

On Linux the test suite launches a real VS Code, which needs a virtual display  - 
install `xvfb` (`sudo apt-get install -y xvfb`). macOS needs nothing extra.

## Tasks

Run `make` to list every task:

| Command | Description |
| --- | --- |
| `make compile` | Type-check and bundle the extension |
| `make watch` | Rebuild the bundle on change |
| `make lint` | Run ESLint |
| `make test` | Run the test suite (uses `xvfb` on Linux) |
| `make check` | Lint, compile, and test |
| `make fetch-server` | Download the pinned `clj-pulse` for this machine into `server/` |
| `make package` | Build the `.vsix` for this machine, with `clj-pulse` bundled |
| `make package-universal` | Build the `.vsix` without a bundled server |
| `make install-extension` | Build the `.vsix` and install it into VS Code |

Press <kbd>F5</kbd> in VS Code to launch an Extension Development Host with the
extension loaded.

## Install it on your own projects

To run Clojure Pulse day-to-day from source - like a Marketplace install, but
local - build and install the `.vsix` (requires the `code` command on your
`PATH`):

```sh
make install-extension
```

That fetches the pinned `clj-pulse` for your platform and runs
`code --install-extension clojure-pulse-<platform>-<version>.vsix --force`.
You can also install it from the UI: Extensions view → **⋯** → **Install from
VSIX…**. Reload VS Code afterwards, and rerun the command to update after
changes (bump `version` in `package.json` for clean version tracking).

## Releasing

An extension release carries exactly one `clj-pulse` version, pinned as
`cljPulseVersion` in `package.json`. To release:

1. Bump `version` in `package.json`.
2. Bump `cljPulseVersion` to the
   [clj-pulse release](https://github.com/abogoyavlensky/clj-pulse/releases)
   to ship.
3. Commit, then `make tag`.

The release workflow builds one `.vsix` per platform, each with that
`clj-pulse` inside, plus the universal build, and publishes them all to
GitHub Releases.
