# Format Selection indents a mid-line top-level form from column 0

**Status: open**

## Problem

`formatRange` (the cljfmt engine, `src/fmt/cljfmtEngine.ts`) hands cljfmt a
slice that starts at the top-level form's opener. cljfmt then indents the
form's body as if it sat at column 0, so when the form does *not* start its
line every inner column comes out short by the form's real column.

Two ways to hit it:

```clojure
^:private (a
b)        ; Format Selection puts `b` at column 1, cljfmt puts it at 11

(x) (b
c)        ; Format Selection puts `c` at column 1, cljfmt puts it at 5
```

Glued reader prefixes (`#_`, `'`, `#?`, `@`, `#(`) are already correct: the
backward walk in `formatRange` extends the slice over them.

Narrow in practice — it needs Format Selection, or `editor.formatOnPaste`
(which routes to the same provider), over a top-level form that does not begin
its line. Format Document is unaffected, which is why the code carries this as
a noted limitation rather than a bug.

## Fix

Pad the slice with spaces up to the form's column before calling
`reformatString`, then strip the same padding from the output. This leans on
the property `formatRange` already relies on: cljfmt never reindents the first
line of its input, so a slice that begins at the form's real column produces
the columns the whole file would.

Measured against whole-file cljfmt:

| input | today | padded | whole-file cljfmt |
| --- | --- | --- | --- |
| `^:private (a\nb)` | `b` at 1 | `b` at 11 | `b` at 11 |
| `(x) (b\nc)` | `c` at 1 | `c` at 5 | `c` at 5 |
| `#_(a\nb)` | `b` at 3 | `b` at 3 | `b` at 3 |
| `#(a\nb)` | `b` at 2 | `b` at 2 | `b` at 2 |

Notes for whoever picks this up:

- Keep the glued-prefix backward walk and pad only the columns before it, so
  the prefix reaches cljfmt verbatim. Padding alone matched all four cases
  above, but that is too little evidence to delete the walk.
- Leave the "whitespace-only prefix" branch alone: a top-level form indented by
  mistake moves to column 0 there, matching whole-file cljfmt.
- Cover reader-conditional splicing (`#?@(:clj [a\nb])`) in the tests; it was
  never actually exercised.

About six lines in `formatRange` plus unit cases in
`src/test/cljfmtEngine.test.ts` that compare `formatRange` output with
`reformatString` over the whole text.

## Origin

Raised by a Codex review during the indent-on-paste work (2026-09-03), which
reported it as glued reader prefixes being dropped. That part was a false
positive; the column offset behind it is real.
