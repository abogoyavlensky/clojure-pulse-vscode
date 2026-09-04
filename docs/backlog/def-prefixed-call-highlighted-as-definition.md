# Calling a `def`-prefixed function highlights its first argument as a name

**Status: open**

## Problem

`(defenders team)` — a call to an ordinary function whose name happens to start
with `def` — is painted as a definition: `defenders` gets
`keyword.control.clojure` and `team` gets `entity.global.clojure`, the scope the
name in `(defn team ...)` would get.

The cause is the `meta.definition.global` pattern in the `sexp` rule
(`syntaxes/clojure.tmLanguage.json:303`), which opens on any paren-headed symbol
matching `def[\w\d._:+=><!?*-]*` and scopes the first symbol inside as the
defined name:

```
(?<=\()(ns|declare|def[\w\d._:+=><!?*-]*|[\w._:+=><!?*-][\w\d._:+=><!?*-]*/def[\w\d._:+=><!?*-]*)\s+
```

The related let-binding and argument cases — `(let [defenders 1] ...)`,
`(pick defenders team)` — were fixed by requiring head position
(`docs/plans/2026-09-04-0948-let-binding-def-highlight.md`). This one survives
that fix because the call *is* in head position.

## Why it is left alone

A TextMate grammar sees no more than the text. It cannot tell a call to a
function named `defenders` from a use of a user-defined macro, and user-defined
`def*` macros are everywhere: `defroutes`, `defstate`, `defentity`, `deftest`,
`defcomponent`. Replacing the `def*` wildcard with a whitelist of known forms
would mishighlight all of them to fix a rarer case — functions named `def*` are
unusual, since the prefix conventionally means "this defines something".

A real fix needs semantics, not text: semantic tokens from `clj-pulse`, which
knows whether the head resolves to a macro or a function. That is the route to
take if this is ever picked up.

## Origin

Noticed while narrowing the `keyfn` patterns to head position (2026-09-04).
