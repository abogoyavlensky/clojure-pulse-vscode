# Testing

[Documentation](README.md) · [Clojure Pulse](../README.md)

## Change code, rerun the last test

Run **Clojure Pulse: Run Test at Cursor** in a `deftest`, then switch to its
implementation and make a change. **Run Last Test Command** repeats the test
without opening its file or moving your focus. It also remembers namespace
runs. Bind it once and keep testing from the code you are working on.

Tests use the active REPL. Start or connect to one in the [REPL manager](repl.md)
first. For JVM Clojure, single-test execution requires Clojure 1.11 or newer.

## Run Test at Cursor

Place the cursor inside a top-level `deftest`, or immediately after its closing
paren. The command re-evaluates the test in the file's namespace, then runs it
through `clojure.test`. If the namespace is not loaded yet, it loads the file
first. The test summary appears inline; the full report goes to the REPL output.

```clojure
(ns demo.core-test
  (:require [clojure.test :refer [deftest is]]))

(deftest addition
  (is (= 4 (+ 2 2))))
```

Run the command with the cursor inside `addition` to see its verdict.

## Run Tests in Namespace

This command loads the current buffer, including unsaved changes, then runs
its top-level `deftest` forms one at a time. Helpers and tests are refreshed
before execution. Each gutter mark appears as its test finishes; a failing test
does not stop the remaining tests. Namespace runs leave results in the gutter,
status bar, and REPL output rather than adding inline results to every form.

A compilation error aborts the run and produces a notification.

## Run Last Test Command

Repeat the last cursor or namespace run from any file. The command re-reads the
test file, including unsaved edits, and finds a single test by namespace and
name. It keeps working when that test moves within the file. If the test was
renamed or deleted, the status bar explains why it cannot run.

The test file receives the same gutter marks and the status bar shows the same
verdict. Your focus stays in the implementation file. The
[reload step](#reload-before-tests) brings changed code into the REPL when
clj-reload is available.

## Reading results

- A green gutter check means pass; a red cross means failure or error.
  Hover the test's first line for the failure report.
- The status bar shows a spinner during execution, then the test or namespace
  name with its verdict. Click it for the full REPL output.
- Single-test runs also show an inline summary. If inline results are disabled,
  the output channel is revealed without receiving keyboard focus.
- Gutter marks describe the **last test command**. A new run clears the previous
  report; editing a marked test removes its stale verdict.
- Tests, file evaluation, and custom commands share a status-bar slot. A newer
  operation replaces that indicator; test gutter marks remain.

**Clear status bar** dismisses the indicator without cancelling a run.

## Reload before tests

With `clojurePulse.test.reloadBeforeRun` set to `"clj-reload"` (the default),
every test command saves dirty Clojure files and reloads changed namespaces and
their dependents through [clj-reload](https://github.com/tonsky/clj-reload).
Reloads follow dependency order and preserve `defonce` vars. A compilation
failure aborts the test run; a notification names the namespace and the first
error line, with the full trace in the REPL output.

The REPL manager's prefilled Clojure CLI command includes clj-reload. For
Leiningen, add `[io.github.tonsky/clj-reload "1.0.0"]` to your `:dev` profile.
Existing saved configurations retain their commands until you edit them.
Without clj-reload on the classpath, tests run without reloading and the status
bar explains this once per connection. Set the setting to `"none"` to skip
saving and reloading before tests.

### Project state and reload hooks

The extension calls `clj-reload.core/reload`; it does not call `init` or your
project's reset function. Your own initialization in `user.clj` controls
`:no-unload`, `:no-reload`, and other options. Integrant, Component, or Mount
systems are not automatically restarted. Use your project's reload hooks or a
[custom REPL command](repl.md#custom-commands) when state needs to be reset.
clj-reload's `before-ns-unload`, `after-ns-reload`, and `^:clj-reload/keep`
continue to work.

If clj-reload watches no files, the status bar reports it once per connection.
Check your `init` file pattern: it must match the whole file name. Use
`#".*\.cljc?"`, not the tools.namespace-style `#"\.clj"`.
`integrant.repl`'s `set-reload-options!` passes `:file-pattern` through as `:files`.

### Limits

- clj-reload reads files from disk. Untitled buffers have no file to reload.
- Change tracking starts when `clj-reload.core` is first required. The extension
  requires it on connection. For an externally started REPL, edits made before
  connection can be missed; require it in `user.clj` to start tracking earlier.
- Reloading through clj-reload is JVM-only; let-go runs tests without this step.
- Namespace runs skip discarded `#_(deftest …)` forms and tests wrapped in
  reader conditionals such as `#?(:clj (deftest …))`.
- Namespace runs execute tests individually, so `:once` fixtures run once per
  test, not once per namespace.
- On let-go without `run-test-var`, the fallback calls the test function
  directly and skips `use-fixtures` fixtures.

See [Keybindings](keybindings.md) for cursor, namespace, and rerun shortcuts.
