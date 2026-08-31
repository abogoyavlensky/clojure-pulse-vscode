import * as assert from "assert";
import { LineIndent } from "../fmt/engine";
import { structuralEngine } from "../fmt/structuralEngine";

/** Applies line-indent edits to `text` for readable whole-text assertions. */
function applyIndents(text: string, edits: LineIndent[]): string {
  const lines = text.split("\n");
  for (const edit of edits) {
    const line = lines[edit.line];
    const content = line.replace(/^ */, "");
    lines[edit.line] = " ".repeat(edit.indent) + content;
  }
  return lines.join("\n");
}

function reindented(text: string): string {
  const edits = structuralEngine.formatDocument(text);
  assert.ok(edits !== null);
  assert.ok(edits.every((e) => e.kind === "line"));
  return applyIndents(text, edits as LineIndent[]);
}

suite("structuralEngine.formatDocument", () => {
  test("reindents nested forms against the rewritten prefix", () => {
    const input = "(defn f [x]\n(let [y 1]\n(inc y)))";
    assert.strictEqual(reindented(input), "(defn f [x]\n  (let [y 1]\n    (inc y)))");
  });

  test("aligns collection items to the first element", () => {
    assert.strictEqual(reindented("[1 2\n3]"), "[1 2\n 3]");
    assert.strictEqual(reindented("{:a 1\n:b 2}"), "{:a 1\n :b 2}");
  });

  test("symbol-headed list bodies get the two-space rule", () => {
    assert.strictEqual(reindented("(foo bar\nbaz)"), "(foo bar\n  baz)");
  });

  test("multiline string content is untouched, code after it reindents", () => {
    const input = '(def s "line1\n   in string")\n  (inc 1)';
    assert.strictEqual(reindented(input), '(def s "line1\n   in string")\n(inc 1)');
  });

  test("blank and space-only lines stay as they are", () => {
    const input = "(foo\n\n   \nbar)";
    assert.strictEqual(reindented(input), "(foo\n\n   \n  bar)");
  });

  test("tab-indented lines are left alone", () => {
    const input = "(foo\n\tbar)";
    assert.deepStrictEqual(structuralEngine.formatDocument(input), []);
  });

  test("lines anchored to a tab-indented opener are left alone too", () => {
    // `(bar` sits on a tab line, so its column is a guess (a tab scans as
    // one unit) — `baz` must not be re-anchored to it. A deeper form opened
    // on a clean line is trustworthy again.
    assert.deepStrictEqual(structuralEngine.formatDocument("(foo\n\t(bar\nbaz))"), []);
    assert.deepStrictEqual(
      structuralEngine.formatDocument("(foo\n\t(bar\n  (baz\nqux))))"),
      [{ kind: "line", line: 3, indent: 4 }],
    );
  });

  test("already-correct input yields no edits", () => {
    assert.deepStrictEqual(
      structuralEngine.formatDocument("(defn f [x]\n  (inc x))"),
      [],
    );
  });

  test("a shifted opener cascades to its children", () => {
    // `(bar` sits inside `(foo …)`; once its line moves to column 2, the
    // child line under it must anchor to the *rewritten* column, not col 4.
    const input = "(foo\n    (bar\n      baz)\n  qux)";
    assert.strictEqual(reindented(input), "(foo\n  (bar\n    baz)\n  qux)");
  });
});

suite("structuralEngine.formatRange", () => {
  test("touches only lines inside the range", () => {
    const input = "(foo\nbar\nbaz)";
    const edits = structuralEngine.formatRange(input, 1, 1);
    assert.ok(edits !== null);
    assert.deepStrictEqual(edits, [{ kind: "line", line: 1, indent: 2 }]);
  });
});

suite("structuralEngine.indentAt", () => {
  test("matches indentColumnAt", () => {
    assert.strictEqual(structuralEngine.indentAt("(foo ", 5), 2);
    assert.strictEqual(structuralEngine.indentAt("[1 ", 3), 1);
    assert.strictEqual(structuralEngine.indentAt('"str ', 5), null);
  });
});
