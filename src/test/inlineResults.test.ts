import * as assert from "assert";
import {
  buildHoverMarkdown,
  formatInlineText,
  renderRange,
  shiftRange,
  SimpleRange,
} from "../repl/inlineResults";

const NBSP = "\u00a0";

suite("formatInlineText", () => {
  test("returns the bare value with no arrow prefix", () => {
    assert.strictEqual(formatInlineText("42"), "42");
  });

  test("keeps only the first line", () => {
    assert.strictEqual(
      formatInlineText("line one\nline two"),
      `line${NBSP}one`,
    );
  });

  test("replaces every space so nothing collapses", () => {
    assert.strictEqual(
      formatInlineText("{:a 1, :b 2}"),
      `{:a${NBSP}1,${NBSP}:b${NBSP}2}`,
    );
  });

  test("caps long values at 120 characters with an ellipsis", () => {
    const out = formatInlineText("x".repeat(200));
    assert.strictEqual(out.length, 120);
    assert.ok(out.endsWith("…"));
  });

  test("short values are not truncated", () => {
    assert.ok(!formatInlineText("small").includes("…"));
  });
});

suite("renderRange", () => {
  test("a single-line form extends to the end of its line", () => {
    assert.deepStrictEqual(
      renderRange(
        { start: { line: 0, character: 3 }, end: { line: 0, character: 8 } },
        15,
      ),
      { start: { line: 0, character: 3 }, end: { line: 0, character: 15 } },
    );
  });

  test("a multi-line form ends at the end of its last line", () => {
    assert.deepStrictEqual(
      renderRange(
        { start: { line: 0, character: 0 }, end: { line: 2, character: 4 } },
        10,
      ),
      { start: { line: 0, character: 0 }, end: { line: 2, character: 10 } },
    );
  });
});

suite("buildHoverMarkdown", () => {
  test("wraps the full value in a clojure fence", () => {
    const md = buildHoverMarkdown("{:a 1}", "eval-7");
    assert.ok(md.includes("```clojure\n{:a 1}\n```"), md);
  });

  test("includes a copy command link carrying the result id", () => {
    const md = buildHoverMarkdown("42", "eval-7");
    const args = encodeURIComponent(JSON.stringify(["eval-7"]));
    assert.ok(
      md.includes(`command:clojurePulse.copyEvalResult?${args}`),
      md,
    );
  });

  test("multi-line values keep all their lines in the fence", () => {
    const md = buildHoverMarkdown("line one\nline two", "eval-1");
    assert.ok(md.includes("line one\nline two"), md);
  });
});

suite("shiftRange", () => {
  const range = (
    sl: number,
    sc: number,
    el: number,
    ec: number,
  ): SimpleRange => ({
    start: { line: sl, character: sc },
    end: { line: el, character: ec },
  });

  test("an edit entirely below leaves the range untouched", () => {
    const r = range(2, 0, 2, 8);
    const shifted = shiftRange(r, {
      range: range(5, 0, 5, 0),
      text: "\nmore",
    });
    assert.deepStrictEqual(shifted, r);
  });

  test("inserting a line above shifts the range down", () => {
    const r = range(5, 0, 5, 8);
    const shifted = shiftRange(r, {
      range: range(1, 0, 1, 0),
      text: "\n",
    });
    assert.deepStrictEqual(shifted, range(6, 0, 6, 8));
  });

  test("deleting lines above shifts the range up", () => {
    const r = range(5, 0, 5, 8);
    const shifted = shiftRange(r, {
      range: range(1, 0, 3, 0),
      text: "",
    });
    assert.deepStrictEqual(shifted, range(3, 0, 3, 8));
  });

  test("a multi-line replacement shifts by the net line delta", () => {
    const r = range(10, 0, 10, 4);
    const shifted = shiftRange(r, {
      range: range(2, 0, 4, 0), // removes 2 lines
      text: "a\nb\nc\n", // adds 3 lines
    });
    assert.deepStrictEqual(shifted, range(11, 0, 11, 4));
  });

  test("an edit intersecting the range drops it", () => {
    const r = range(3, 2, 3, 10);
    assert.strictEqual(
      shiftRange(r, { range: range(3, 4, 3, 6), text: "z" }),
      null,
    );
  });

  test("an edit touching the start boundary shifts rather than drops", () => {
    const r = range(3, 5, 3, 9);
    const shifted = shiftRange(r, {
      range: range(3, 5, 3, 5),
      text: "  ",
    });
    // Insert on the same line before the form shifts its characters.
    assert.deepStrictEqual(shifted, range(3, 7, 3, 11));
  });

  test("an edit touching the end boundary leaves the range untouched", () => {
    const r = range(3, 0, 3, 4);
    const shifted = shiftRange(r, {
      range: range(3, 4, 3, 4),
      text: "xyz",
    });
    assert.deepStrictEqual(shifted, r);
  });
});
