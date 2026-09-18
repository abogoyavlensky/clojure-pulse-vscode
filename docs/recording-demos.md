# Recording feature demos

[Development](development.md) · [Documentation](README.md)

Capture the installed extension in VS Code. Use the same small project,
readable font size, and theme across clips. Keep each clip to one action
sequence, roughly 8-15 seconds, and pause briefly on the result. Show the
shortcut used, and link to the [keybinding examples](keybindings.md).

Store finished clips in `docs/images/` under the names below. Add them to the
matching README sections once they have been recorded and reviewed. Check the
README in both GitHub and the installed VSIX. The existing `inline-result.png`,
`external_libs.png`, and `split_sidebar_panel.png` are historical design
references, not verified captures of the current extension.

## REPL manager: `repl-manager.gif`

1. Open Clojure Pulse's REPL view and click **+**.
2. Name a create configuration `dev`, show the prefilled command, and save.
3. Start it from its row; finish with the connected status and output visible.

A separate connect clip can show an existing `.nrepl-port` configuration.
Keep first-run dependency downloads outside the clip.

## Whole-form movement: `indentation.gif`

Start with this inside a rich comment:

```clojure
(comment
  {:name    "Ada"
   :role    :developer
   :active? true})
```

Place the cursor before `{` and press Tab with spaces enabled. Hold on the
whole map shifting together, then undo. In a separate clip, paste the same map
into the rich comment and show its layout surviving the new indentation.

## Inline evaluation: `inline-evaluation.gif`

```clojure
(comment
  (mapv inc [1 2 3]))
```

Put the cursor immediately after the `mapv` form. Evaluate it, hold on the
inline `[2 3 4]`, then hover the result and use **Copy result**. Record the
actual result decoration; the code sample above contains no simulated output.

## Rerun the last test: `rerun-last-test.gif`

Use a JVM Clojure project with `src` and `test` on its classpath, and clj-reload
available in its REPL. Put this in `src/demo/core.clj`:

```clojure
(ns demo.core)

(defn total [price quantity]
  (+ price quantity))
```

Put this in `test/demo/core_test.clj`:

```clojure
(ns demo.core-test
  (:require [clojure.test :refer [deftest is]]
            [demo.core :as core]))

(deftest order-total
  (is (= 30 (core/total 10 3))))
```

Run the test and show the red verdict. Switch to `core.clj`, change `+` to `*`,
and invoke **Run Last Test Command** using its shortcut. Finish on the green
status while the implementation file remains focused. A split editor can keep
the test's gutter result visible too.

## Custom command: `custom-command.gif`

Create `reset` in REPL Commands with `(user/reset)` in a project that defines
that function. Invoke it with the documented Cmd+K, Cmd+R shortcut and show the
status verdict. Keep the editor focused throughout.

## Libraries and monorepos

Expand two detected projects in External Libraries, expand a dependency, and
open a source file. Show definition navigation within that source. Record
ClojureDocs separately: put the cursor on `map`, run **Show ClojureDocs**, and
scroll the focused hover.
