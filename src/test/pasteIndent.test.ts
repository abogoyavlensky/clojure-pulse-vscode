import * as assert from "assert";
import { defaultConfig } from "@abogoyavlensky/cljfmt-js";
import { createCljfmtEngine } from "../fmt/cljfmtEngine";
import { structuralEngine } from "../fmt/structuralEngine";
import { IndentAt, planPaste, PastePlan } from "../pasteIndent";

/** The def-with-map form from the bug report, as copied. */
const DEF_WITH_MAP = "(def TEST\n  {:a 1\n   :b 2})";

/**
 * Plans a paste into `marked` — a document where `|` marks the caret, or two
 * `|`s mark the replaced selection. The markers are stripped before planning.
 */
function paste(
  marked: string,
  clipboard: string,
  indentAt: IndentAt = structuralEngine.indentAt,
): PastePlan | null {
  const start = marked.indexOf("|");
  assert.notStrictEqual(start, -1, "the document must carry a `|` caret marker");
  const rest = marked.slice(start + 1).indexOf("|");
  const end = rest === -1 ? start : start + rest;
  const text = marked.split("|").join("");
  return planPaste({ text, start, end, clipboard }, indentAt);
}

suite("planPaste", () => {
  test("a def with a map body follows the paste column", () => {
    assert.deepStrictEqual(paste("(comment\n  |)", DEF_WITH_MAP), {
      lines: ["(def TEST", "    {:a 1", "     :b 2})"],
      deleteBefore: 0,
    });
  });

  test("pasting at column 0 indents the first line too", () => {
    assert.deepStrictEqual(paste("(comment\n|)", DEF_WITH_MAP), {
      lines: ["  (def TEST", "    {:a 1", "     :b 2})"],
      deleteBefore: 0,
    });
  });

  test("a line indented past the target dedents by deleting spaces", () => {
    assert.deepStrictEqual(paste("(comment\n      |)", DEF_WITH_MAP), {
      lines: ["(def TEST", "    {:a 1", "     :b 2})"],
      deleteBefore: 4,
    });
  });

  test("a mid-line paste leaves the first line exactly as copied", () => {
    assert.deepStrictEqual(paste("(foo |)", DEF_WITH_MAP), {
      lines: ["(def TEST", "       {:a 1", "        :b 2})"],
      deleteBefore: 0,
    });
  });

  test("blank lines inside the pasted form stay blank", () => {
    assert.deepStrictEqual(paste("(comment\n  |)", "(def TEST\n\n  {:a 1\n   :b 2})"), {
      lines: ["(def TEST", "", "    {:a 1", "     :b 2})"],
      deleteBefore: 0,
    });
  });

  test("lines inside a multi-line string keep their own columns", () => {
    assert.deepStrictEqual(paste("(comment\n|)", '(def s "a\n  b")'), {
      lines: ['  (def s "a', '  b")'],
      deleteBefore: 0,
    });
  });

  test("tab-indented lines are never touched", () => {
    assert.deepStrictEqual(paste("(comment\n  |)", "(def TEST\n  {:a 1\n\t:b 2})"), {
      lines: ["(def TEST", "    {:a 1", "\t:b 2})"],
      deleteBefore: 0,
    });
  });

  test("a negative shift stops at column 0", () => {
    assert.deepStrictEqual(paste("(comment\n|)", "(def TEST\n      {:a 1\n :b 2})"), {
      lines: ["  (def TEST", "    {:a 1", ":b 2})"],
      deleteBefore: 0,
    });
  });

  test("a single-line clipboard pasted mid-line needs no plan", () => {
    assert.strictEqual(paste("(foo |)", "bar"), null);
  });

  test("a selection is replaced and the body follows its start", () => {
    assert.deepStrictEqual(paste("(comment\n  |xxx|)", DEF_WITH_MAP), {
      lines: ["(def TEST", "    {:a 1", "     :b 2})"],
      deleteBefore: 0,
    });
  });

  test("a paste inside a string is string content", () => {
    assert.strictEqual(paste('(def s "a|b")', DEF_WITH_MAP), null);
  });

  test("an already-correct paste needs no plan", () => {
    assert.strictEqual(
      paste("(comment\n  |)", "(def TEST\n    {:a 1\n     :b 2})"),
      null,
    );
  });

  test("a CRLF clipboard splits on its own line endings", () => {
    assert.deepStrictEqual(paste("(comment\n  |)", "(def TEST\r\n  {:a 1\r\n   :b 2})"), {
      lines: ["(def TEST", "    {:a 1", "     :b 2})"],
      deleteBefore: 0,
    });
  });

  test("the cljfmt engine indents the same def body", () => {
    const indentAt = createCljfmtEngine({ config: defaultConfig, maxInner: 2 }).indentAt;
    assert.deepStrictEqual(paste("(comment\n  |)", DEF_WITH_MAP, indentAt), {
      lines: ["(def TEST", "    {:a 1", "     :b 2})"],
      deleteBefore: 0,
    });
  });
});
