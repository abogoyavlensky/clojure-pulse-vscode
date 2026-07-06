# Changelog

All notable changes to the Clojure Pulse extension are documented in this file.

## [Unreleased]

- nREPL support: **Connect to Running nREPL** (port pre-filled from
  `.nrepl-port`), **Evaluate Selection**, and **Disconnect** commands; a
  Cursive-style **REPL** pane in the bottom panel streaming banners, evaluated
  forms, values, and stdout/stderr; and an `nREPL host:port` status bar item
  with a connect / Show REPL / Disconnect menu.

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
