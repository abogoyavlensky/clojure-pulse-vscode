# Testing

[Documentation](README.md) · [Clojure Pulse](../README.md)

## Change code, rerun the last test

Run **Clojure Pulse: Run Test at Cursor** in a `deftest`, then switch to its
implementation and make a change. **Run Last Test Command** repeats the test
without opening its file or moving your focus. It also remembers namespace
runs. Bind it once and keep testing from the code you are working on.

Tests use the active REPL. Start or connect to one in the [REPL manager](repl.md)
first. For JVM Clojure, single-test execution requires Clojure 1.11 or newer.

## Run Last Test Command

repeats whatever test command ran last, from
anywhere. The Cursive workflow this copies: run a `deftest`, switch to the
business-logic code, change something, then re-run the test without ever
leaving the file you're in. The change is saved and reloaded for you. The command re-reads the test
file's current content (unsaved edits included), finds the test again by
namespace and name - so it survives the deftest moving around the file - and
runs it exactly as the original command would: same gutter marks on the test
file, same status-bar verdict. Focus stays where you are; the test file is
never opened or revealed. If the recorded test has since been renamed or
deleted, a status-bar message says so instead of guessing.

## Run Test at Cursor

with the cursor inside a top-level `deftest` (or
right after its closing paren), re-evaluates the test in the file's namespace
so the buffer's current version is what runs, then executes it via
`clojure.test`. If the namespace isn't loaded yet, the file is loaded
automatically first - no manual **Evaluate File** needed. The summary map
(`{:test 1, :pass 2, :fail 0, …}`) appears inline on the form; the full
report streams to the REPL's output channel without moving focus there
(when inline results are off, the channel is shown up front, as for every
eval command - revealed, never focused). The gutter marks the deftest with a green check circle on
pass or a red cross circle on fail - hover the deftest's first line for the
failure report - and the status bar shows the verdict at a glance: the test
name in green when it passed, on a red background with fail/error counts
when it didn't; click it to open the REPL output. Marks always show the
result of the **last test command** only: a new run wipes the previous
report, and an edit to a marked deftest removes its (now stale) gutter
verdict. The status bar's verdict spot is shared with custom REPL commands
and **Evaluate File** - it shows the last run of any kind, so a newer run
replaces what is on display (the gutter marks keep the test report either
way). Works against JVM Clojure (1.11+) and
let-go REPLs - with one let-go caveat: until let-go gains `run-test-var`, a
single-test run there calls the test function directly, skipping
`use-fixtures` fixtures.

## Run Tests in Namespace

runs every top-level `deftest` in the current
buffer. The buffer is loaded first (as **Evaluate File** does), so helpers
and tests are refreshed and what runs is exactly what you see; then each
test runs in turn, and its gutter mark appears as it finishes. A failing
test does not stop the run. The status bar shows the namespace name - a
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

## Reload before tests

every test command starts by saving the dirty
Clojure files and reloading the namespaces whose files changed on disk,
along with the namespaces that depend on them, so the code you just edited
is the code the test runs against. It uses
[clj-reload](https://github.com/tonsky/clj-reload), which the prefilled
Clojure CLI command puts on the classpath for you. A file that no longer
compiles aborts the run: a notification names the namespace and the error's
first line, and the full trace is in the REPL's output channel. Without
clj-reload on the classpath the tests run as they always did, and the status
bar says so once per connection. Set
`clojurePulse.test.reloadBeforeRun` to `"none"` to turn the whole step off.
See [Reload before tests](testing.md#reload-before-tests) for what the extension
assumes about your project.

The test commands reload what changed before they run, through
[clj-reload](https://github.com/tonsky/clj-reload). It reloads only the
namespaces whose files changed on disk and the namespaces that depend on them,
in dependency order, and `defonce` vars survive the reload.

**What the extension assumes: nothing.** It calls plain
`clj-reload.core/reload` and nothing else. It never calls `init`, so your own
`init` in `user.clj` (with `:no-unload`, `:no-reload`, `:output`) wins. It
never calls a project's own reset wrapper, so an Integrant, Component or Mount
system is not restarted before your test. A project that wants state to follow
reloads uses clj-reload's own `before-ns-unload` and `after-ns-reload` hooks,
plus `defonce` and `^:clj-reload/keep`; those fire inside `reload` and work
here unchanged.

If clj-reload is watching no files, the status bar says so once per
connection. That is almost always an `init` whose `:files` regex matches
nothing: clj-reload matches the *whole* file name, so tools.namespace's
`#"\.clj"` idiom matches none of them, and every reload quietly does nothing.
Use `#".*\.cljc?"` instead. (`integrant.repl`'s `set-reload-options!` passes
its `:file-pattern` straight through to clj-reload as `:files`.)

Three limits worth knowing:

- clj-reload reads files from disk. Dirty editors are saved first, but an
  untitled buffer has no file, so it is never reloaded.
- clj-reload's idea of "changed" starts when `clj-reload.core` is first
  required. Clojure Pulse requires it the moment a REPL connects. For a
  `connect` REPL you started yourself, edits made between the JVM starting and
  the extension connecting are missed; `(require 'clj-reload.core)` in your
  `user.clj` closes that window.
- It is JVM-only. On let-go the reload probe finds nothing to call and the
  tests run without reloading.

See [Keybindings](keybindings.md) for cursor, namespace, and rerun shortcuts.
