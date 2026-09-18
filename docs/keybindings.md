# Your keybindings

[Documentation](README.md) · [Clojure Pulse](../README.md)

Evaluation, testing, and REPL commands leave shortcut selection to you.
Bind the actions you use, with the keys that fit your workflow. The extension
only supplies Enter for indentation and Escape for clearing inline results.

Run **Preferences: Open Keyboard Shortcuts (JSON)** from the Command Palette.
Add any of the following entries to your existing array. These are personal
examples, not defaults; they override other bindings when their `when`
conditions match. See [VS Code's keybinding guide](https://code.visualstudio.com/docs/configure/keybindings)
for editing bindings and resolving conflicts.

## macOS example

| Shortcut | Action |
| --- | --- |
| Cmd+N | Evaluate current form or selection |
| Cmd+Shift+N | Run test at cursor |
| Cmd+Shift+M | Run tests in namespace |
| Cmd+Shift+L | Rerun last test command, including from the implementation file |
| Option+Shift+L | Evaluate file |
| Cmd+K, Cmd+R | Run the saved `reset` command |
| Cmd+K, Cmd+S | Run the saved `stop` command |
| Ctrl+R | Start or connect a REPL |
| Cmd+F2 | Stop or disconnect a REPL |
| F1 | Show ClojureDocs |
| Cmd+M | Select current form |

```json
[
  {
    "key": "cmd+n",
    "command": "clojurePulse.evalCurrentForm",
    "when": "editorTextFocus && !editorReadonly && editorLangId == clojure && isMac"
  },
  {
    "key": "cmd+shift+n",
    "command": "clojurePulse.runTestAtCursor",
    "when": "editorTextFocus && !editorReadonly && editorLangId == clojure && isMac"
  },
  {
    "key": "cmd+shift+m",
    "command": "clojurePulse.runNsTests",
    "when": "editorTextFocus && !editorReadonly && editorLangId == clojure && isMac"
  },
  {
    "key": "cmd+shift+l",
    "command": "clojurePulse.rerunLastTest",
    "when": "editorTextFocus && !editorReadonly && editorLangId == clojure && isMac"
  },
  {
    "key": "alt+shift+l",
    "command": "clojurePulse.evalFile",
    "when": "editorTextFocus && !editorReadonly && editorLangId == clojure && isMac"
  },
  {
    "key": "cmd+k cmd+r",
    "command": "clojurePulse.runCustomReplCommand",
    "args": "reset",
    "when": "editorTextFocus && !editorReadonly && editorLangId == clojure && isMac"
  },
  {
    "key": "cmd+k cmd+s",
    "command": "clojurePulse.runCustomReplCommand",
    "args": "stop",
    "when": "editorTextFocus && !editorReadonly && editorLangId == clojure && isMac"
  },
  {
    "key": "ctrl+r",
    "command": "clojurePulse.startRepl",
    "when": "editorTextFocus && !editorReadonly && editorLangId == clojure && isMac"
  },
  {
    "key": "cmd+f2",
    "command": "clojurePulse.stopRepl",
    "when": "editorTextFocus && !editorReadonly && editorLangId == clojure && isMac"
  },
  {
    "key": "f1",
    "command": "clojurePulse.showClojureDocs",
    "when": "editorTextFocus && !editorReadonly && editorLangId == clojure && isMac"
  },
  {
    "key": "cmd+m",
    "command": "clojurePulse.selectCurrentForm",
    "when": "editorTextFocus && !editorReadonly && editorLangId == clojure && isMac"
  }
]
```

## Windows and Linux

Choose keys that are comfortable on your keyboard. This small starting point
uses Ctrl+Alt combinations and is limited to Clojure editors outside macOS:

```json
[
  {
    "key": "ctrl+alt+e",
    "command": "clojurePulse.evalCurrentForm",
    "when": "editorTextFocus && !editorReadonly && editorLangId == clojure && !isMac"
  },
  {
    "key": "ctrl+alt+t",
    "command": "clojurePulse.runTestAtCursor",
    "when": "editorTextFocus && !editorReadonly && editorLangId == clojure && !isMac"
  },
  {
    "key": "ctrl+alt+l",
    "command": "clojurePulse.rerunLastTest",
    "when": "editorTextFocus && !editorReadonly && editorLangId == clojure && !isMac"
  }
]
```

## Commands with arguments

Create `reset` and `stop` in the **REPL Commands** panel before using those
shortcuts. For example, save `reset` with `(user/reset)` and `stop` with
`(user/stop)`, assuming those functions exist in your project. Code runs in
the active REPL, so use fully qualified symbols. Rename a saved command and
update its keybinding's `args` to match.

Add `"args": "dev"` to a `clojurePulse.startRepl` binding to start the named
configuration directly. Without an argument, Start REPL opens a picker, or
the configuration form if none exist. Stop REPL and Restart REPL also accept
a configuration name.

**Evaluate Top Form** (`clojurePulse.evalTopForm`) is another useful binding:
evaluate an enclosing `defn` from its body, or a form inside a rich comment.
See the [command reference](reference.md#commands) for the full list.
