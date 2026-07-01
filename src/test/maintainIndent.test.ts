import * as assert from "assert";
import { planShift, ContentChange } from "../maintainIndent";

/** Builds a single-position insertion change. */
function insertAt(line: number, character: number, text: string): ContentChange {
  return {
    range: { start: { line, character }, end: { line, character } },
    text,
  };
}

/** Builds a range-replacement change (pre-edit coordinates). */
function replace(
  startLine: number,
  startChar: number,
  endLine: number,
  endChar: number,
  text: string,
): ContentChange {
  return {
    range: {
      start: { line: startLine, character: startChar },
      end: { line: endLine, character: endChar },
    },
    text,
  };
}

suite("planShift", () => {
  test("spaces typed before a multiline form shift its body lines", () => {
    // `(foo a\n  b)` with two spaces inserted at the form's start.
    const post = "  (foo a\n  b)\n";
    const shifts = planShift(post, insertAt(0, 0, "  "));
    assert.deepStrictEqual(shifts, [{ line: 1, deltaCols: 2 }]);
  });

  test("deleting leading spaces shifts body lines left", () => {
    // `   (foo\n      bar)` with the three leading spaces deleted.
    const post = "(foo\n      bar)\n";
    const shifts = planShift(post, replace(0, 0, 0, 3, ""));
    assert.deepStrictEqual(shifts, [{ line: 1, deltaCols: -3 }]);
  });

  test("newline inserted before a bracket carries the form's body along", () => {
    // Enter+indent before `(b` in `(a (b\n     c))` → the tail `(b` moved
    // from column 3 to column 2.
    const post = "(a \n  (b\n     c))\n";
    const shifts = planShift(post, insertAt(0, 3, "\n  "));
    assert.deepStrictEqual(shifts, [{ line: 2, deltaCols: -1 }]);
  });

  test("typing before a nested multiline form on the same line shifts live", () => {
    // `(foo (bar\n      baz))` with an `x` typed inside `foo`.
    const post = "(foox (bar\n      baz))\n";
    const shifts = planShift(post, insertAt(0, 4, "x"));
    assert.deepStrictEqual(shifts, [{ line: 1, deltaCols: 1 }]);
  });

  test("joining lines shifts the moved tail's children", () => {
    // `(a\n  (b c\n   d))` with the line break (and line 1's indent) deleted.
    const post = "(a  (b c\n   d))\n";
    const shifts = planShift(post, replace(0, 2, 1, 0, ""));
    assert.deepStrictEqual(shifts, [{ line: 1, deltaCols: 2 }]);
  });

  test("the shift cascades through nested forms as whole lines", () => {
    const post = "  (foo (bar\n       baz\n       [qux\n        quux]))\n";
    const shifts = planShift(post, insertAt(0, 0, "  "));
    assert.deepStrictEqual(shifts, [
      { line: 1, deltaCols: 2 },
      { line: 2, deltaCols: 2 },
      { line: 3, deltaCols: 2 },
    ]);
  });

  test("negative shifts clamp at column zero", () => {
    // Three columns removed but the child line only has one leading space.
    const post = "(a\n x)\n";
    const shifts = planShift(post, replace(0, 0, 0, 3, ""));
    assert.deepStrictEqual(shifts, [{ line: 1, deltaCols: -1 }]);
  });

  test("lines inside multiline strings are never shifted", () => {
    const post = '  (foo "a\nb"\n  c)\n';
    const shifts = planShift(post, insertAt(0, 0, "  "));
    assert.deepStrictEqual(shifts, [{ line: 2, deltaCols: 2 }]);
  });

  test("empty lines and tab-indented lines are skipped", () => {
    const post = "  (a\n\n  b)\n";
    assert.deepStrictEqual(planShift(post, insertAt(0, 0, "  ")), [
      { line: 2, deltaCols: 2 },
    ]);
    const tabbed = "  (a\n\tb)\n";
    assert.deepStrictEqual(planShift(tabbed, insertAt(0, 0, "  ")), []);
  });

  test("bails when the affected bracket never closes", () => {
    const post = "  (foo a\n  b\n";
    assert.strictEqual(planShift(post, insertAt(0, 0, "  ")), null);
  });

  test("bails when the edit is inside a string or comment", () => {
    const inString = '"a  b\ncd"\n';
    assert.strictEqual(planShift(inString, insertAt(0, 2, "  ")), null);
    const inComment = "; x (a\n(b\n";
    assert.strictEqual(planShift(inComment, insertAt(0, 2, "x")), null);
  });

  test("no column movement or no affected bracket does nothing", () => {
    // Same-length replacement: nothing moved.
    assert.deepStrictEqual(planShift("(x)\n", replace(0, 1, 0, 2, "y")), []);
    // The tail holds no opener whose form spans lines.
    assert.deepStrictEqual(planShift("(a x b\n c)\n", insertAt(0, 3, "x")), []);
    // Editing the document's last line: nothing follows.
    assert.deepStrictEqual(planShift("(a\n bx)\n", insertAt(1, 2, "x")), []);
  });

  test("bails when the affected form is unreasonably large", () => {
    const post = " (a\n" + " b\n".repeat(1200) + ")\n";
    assert.strictEqual(planShift(post, insertAt(0, 0, " ")), null);
  });
});
