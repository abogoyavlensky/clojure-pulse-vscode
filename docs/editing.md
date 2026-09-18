# Editing and formatting

[Documentation](README.md) · [Clojure Pulse](../README.md)

## Move a whole form with Tab

Put the cursor before the opening bracket of a multiline form and press Tab.
When Tab inserts spaces, the following lines move with it, preserving nested
and hand-aligned code. Moving the opening line with spaces or Enter has the
same effect. Changing an argument-aligned head, such as `->` to `cond->`, also
moves the lines anchored to that argument.

This is **maintained relative indentation**: it shifts the form's layout
without reformatting it. It joins the same undo step as your edit. It skips
multiline strings, tab-indented lines, unbalanced forms, and multi-cursor edits.
Control it with `clojurePulse.maintainIndentation` (default `true`).

## Formatting engines

Two engines sit behind `clojurePulse.formatting.engine`, driving both
indent-on-Enter and Format Document / Format Selection:

- **`cljfmt`** (default) formats exactly like the cljfmt CLI - the extension
  bundles cljfmt 0.16.5 compiled to JavaScript
  ([cljfmt-js](https://github.com/abogoyavlensky/cljfmt-js)), so Format
  Document output is byte-identical to `cljfmt fix` with the same
  configuration, Enter uses the same rules for the new line's column, and
  nothing needs to be installed. For each file the nearest `.cljfmt.edn` or `cljfmt.edn` up
  the directory tree (stopping at the workspace folder) applies, so monorepo
  sub-projects can carry their own rules. `.cljfmt.clj` is not read - it is
  arbitrary Clojure code, which cljfmt itself only evaluates behind an opt-in
  flag.
- **`structural`** is the fixed rule this extension started with: two spaces
  inside symbol-headed lists, alignment to the first element everywhere else,
  no configuration. With this engine Format Document only **re-indents**  - 
  it never strips whitespace, sorts `ns` references, or otherwise rewrites
  code.

On Enter the cljfmt engine reformats only a small window around the cursor,
so big files and giant `comment` blocks stay fast; when the code around the
cursor is too unbalanced to parse mid-edit, the structural rule answers
instead - Enter never fails. Format-on-save is VS Code's own switch: set
`"editor.formatOnSave": true` under `"[clojure]"` if you want it.

A config file that fails to parse never breaks formatting - the defaults
apply, a warning appears once when the breaking save happens, and a
`$(warning) cljfmt config` status-bar item stays visible (click it to open
the file) until the config parses again.

## Enter and paste

Enter inserts a newline and its indentation as one edit. When a completion
widget or snippet handles Enter, the extension reindents the new line after
that action. The active engine supplies the column.

Pasting a multiline form shifts all its lines by the same amount to fit its
new position. Hand-aligned maps and nested forms retain their internal layout.
For example, paste a `defn` into a `(comment …)` block: its body follows the
new opening column. Enable `editor.formatOnPaste` for a full reformat instead;
disabling `editor.pasteAs.enabled` disables the paste provider.

## See the form you will evaluate

The highlighted brackets surround the form **Evaluate Current Form** would
send. **Select Current Form** selects that same form. These actions understand
rich comments and `#_` discards; see [Evaluation](repl.md#evaluating).

The extension sets `editor.matchBrackets` to `"never"` for Clojure so the two
bracket matchers do not compete. Set it to `"always"` to restore VS Code's
matcher; Clojure Pulse's highlight then steps aside.

## Ignored forms and comments

`#_` discarded forms and `(comment …)` blocks are dimmed by default.
`clojurePulse.dimIgnoredForms` turns dimming off, and
`clojurePulse.dimIgnoredFormsOpacity` controls the opacity (default `0.6`).
Reload the window after changing either setting.

Toggle Line Comment uses `;` by default. Set `clojurePulse.lineComment` to
`";;"` for two semicolons. The change applies immediately. Toggling matches the
chosen token exactly: with `;;` selected, a line starting with a single `;`
gets another `;;` prefix rather than being uncommented.

## Parinfer and editor defaults

Parinfer Smart Mode also maintains indentation. Set
`clojurePulse.maintainIndentation` to `false` when using it. Parinfer Indent
Mode can complement Clojure Pulse: Pulse indents, Parinfer places brackets.
Remove or rebind `clojurePulse.newline` if another extension should handle Enter.

Clojure Pulse sets `editor.formatOnType` to `false` for Clojure because it
handles Enter itself. See [Settings](reference.md#settings) for all defaults.
