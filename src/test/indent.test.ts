import * as assert from "assert";
import { indentColumnAt } from "../indent";

/** Indent for a cursor at the very end of `source` (the start of the new
 *  line just created by Enter). Mirrors clj-pulse's `indent_at` unit cases —
 *  the two implementations must agree. */
function indent(source: string): number | null {
  return indentColumnAt(source, source.length);
}

suite("indentColumnAt", () => {
  test("vector/map/set aligns to first element", () => {
    assert.strictEqual(indent("(let [a 1\n"), 6);
    assert.strictEqual(indent("[a 1\n"), 1);
    assert.strictEqual(indent("{:a 1\n"), 1);
    assert.strictEqual(indent("#{a\n"), 2);
  });

  test("symbol-headed list indents two spaces", () => {
    assert.strictEqual(indent("(when x\n"), 2);
    assert.strictEqual(indent("(foo bar\n"), 2);
    assert.strictEqual(indent("#(foo\n"), 3);
  });

  test("non-symbol head aligns", () => {
    assert.strictEqual(indent("((f)\n"), 1);
    assert.strictEqual(indent("(:k v\n"), 1);
    assert.strictEqual(indent("(1 2\n"), 1);
    assert.strictEqual(indent("(-5 3\n"), 1);
    assert.strictEqual(indent('("s" x\n'), 1);
  });

  test("minus symbol head is a symbol", () => {
    assert.strictEqual(indent("(- 5\n"), 2);
  });

  test("nested uses innermost open form", () => {
    assert.strictEqual(indent("(a (b c\n"), 5);
  });

  test("inside string or regex returns null", () => {
    assert.strictEqual(indent('"ab\n'), null);
    assert.strictEqual(indent('#"ab\n'), null);
    assert.strictEqual(indent('(f "ab\n'), null);
    // Trailing escape keeps the string open.
    assert.strictEqual(indent('"ab\\\n'), null);
  });

  test("top level is zero", () => {
    assert.strictEqual(indent("(foo)\n"), 0);
    assert.strictEqual(indent("(foo)\nbar\n"), 0);
    assert.strictEqual(indent("\n"), 0);
  });

  test("openers in skipped constructs do not count", () => {
    // ; comment
    assert.strictEqual(indent("; (a\n(foo x\n"), 2);
    // closed string containing a bracket
    assert.strictEqual(indent('"(a" x\n'), 0);
    // closed regex containing a bracket
    assert.strictEqual(indent('#"(a" (f\n'), 8);
    // char literal bracket
    assert.strictEqual(indent("(f \\( x\n"), 2);
    // char literal backslash followed by a real opener
    assert.strictEqual(indent("(f \\\\ (g\n"), 8);
  });

  test("discard is transparent for balance", () => {
    assert.strictEqual(indent("(foo #_(bar) baz\n"), 2);
    assert.strictEqual(indent("(foo #_(bar\n"), 9);
  });

  test("unmatched closer is ignored", () => {
    assert.strictEqual(indent(")\n(foo x\n"), 2);
  });

  test("mismatched closer does not pop the open frame", () => {
    // `]` must not close `(foo` — mid-edit buffers are routinely broken.
    assert.strictEqual(indent("(foo ]\n"), 2);
    // `)` against an open `[` is ignored; the vector stays innermost.
    assert.strictEqual(indent("(a [b ) c\n"), 4);
  });

  test("columns are UTF-16 code units", () => {
    // 😀 is two UTF-16 units: ( f ␠ " 😀 😀 " ␠ ( g → opener ends at 9.
    assert.strictEqual(indent('(f "😀" (g\n'), 10);
  });

  test("cursor offset bounds the scan", () => {
    const text = "(let [a 1])\n";
    // Cursor just after `1`: both the vector and the list are still open.
    assert.strictEqual(indentColumnAt(text, text.indexOf("1") + 1), 6);
    // Offsets past the end clamp to the end.
    assert.strictEqual(indentColumnAt("(foo)\n", 99), 0);
  });
});
