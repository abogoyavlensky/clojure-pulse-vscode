import * as assert from "assert";
import { defaultConfig, readConfig, readNsContext } from "@abogoyavlensky/cljfmt-js";
import { createCljfmtEngine, selectWindow, WINDOW_CAP } from "../fmt/cljfmtEngine";

const DEFAULTS = { config: defaultConfig, maxInner: 2 };

function indentAt(text: string, offset: number, lookup = DEFAULTS): number | null {
  return createCljfmtEngine(lookup).indentAt(text, offset);
}

// Expected columns come from JVM cljfmt: each case was run through
// cljfmt.core/reformat-string with a marker on the new line and the marker's
// column read off. Verified against cljfmt 0.16.5.
suite("cljfmtEngine.indentAt", () => {
  test("let body gets block indentation", () => {
    assert.strictEqual(indentAt("(let [a 1])", 10), 2);
  });

  test("argument on the head line aligns later args", () => {
    assert.strictEqual(indentAt("(foo bar)", 8), 5);
    assert.strictEqual(indentAt("(do (a))", 7), 4);
  });

  test("a second vector on the line anchors to its own bracket", () => {
    const source = "(:require [a :as b][c :as d])";
    assert.strictEqual(indentAt(source, source.indexOf("d")), 20);
  });

  test("head alone gets one space (community)", () => {
    assert.strictEqual(indentAt("(foo)", 4), 1);
  });

  test("letfn binding body needs the depth-3 window", () => {
    // [:inner 2 0]: the rule sits on `letfn`, two ancestors above the
    // cursor's parent form — a shallower window could not see it.
    const text = "(letfn [(sq [y])]\n  body)";
    assert.strictEqual(indentAt(text, text.indexOf("])") + 1), 10);
  });

  test("cursive style from config", () => {
    const lookup = {
      config: readConfig("{:function-arguments-indentation :cursive}"),
      maxInner: 2,
    };
    assert.strictEqual(indentAt("(foo)", 4, lookup), 2);
  });

  test("regex extra-indents from config", () => {
    const lookup = {
      config: readConfig('{:extra-indents {#re "^with-" [[:inner 0]]}}'),
      maxInner: 2,
    };
    assert.strictEqual(indentAt("(with-x y)", 9, lookup), 2);
  });

  test("namespace-qualified key resolves through the ns context", () => {
    const text = "(ns app (:require [my.lib :as ml]))\n(ml/mything x)";
    const lookup = {
      config: readConfig("{:extra-indents {my.lib/mything [[:inner 0]]}}"),
      maxInner: 2,
    };
    const offset = text.length - 1;
    // The Enter window starts at `(ml/mything` — without the file's ns
    // context the alias cannot resolve and cljfmt aligns under `x`.
    assert.strictEqual(indentAt(text, offset, lookup), 12);
    const engine = createCljfmtEngine(lookup, readNsContext(text));
    assert.strictEqual(engine.indentAt(text, offset), 2);
  });

  test("text after the cursor becomes the new line's tail", () => {
    assert.strictEqual(indentAt("(foo bar baz)", 8), 5);
    // Tails starting with characters that are legal *inside* symbols must
    // not fuse with the placeholder into one token.
    assert.strictEqual(indentAt("(foo bar 'baz)", 8), 5);
    assert.strictEqual(indentAt('(foo bar #"re")', 8), 5);
  });

  test("unbalanced text falls back to the structural rule", () => {
    assert.strictEqual(indentAt("(foo (bar", 9), 7);
  });

  test("inside a string there is no indent", () => {
    assert.strictEqual(indentAt('"abc', 4), null);
  });

  test("top level is column zero", () => {
    assert.strictEqual(indentAt("x ", 2), 0);
  });

  test("repeated calls leave the config usable", () => {
    const lookup = {
      config: readConfig("{:function-arguments-indentation :cursive}"),
      maxInner: 2,
    };
    assert.strictEqual(indentAt("(foo)", 4, lookup), 2);
    assert.strictEqual(indentAt("(foo)", 4, lookup), 2);
  });

  test("an oversized innermost form falls back to the structural rule", () => {
    let items = "";
    for (let i = 0; i < 600; i++) {
      items += `:key-${i} ${i} `;
    }
    const text = `(do ${items})`;
    assert.ok(text.length > WINDOW_CAP);
    // Structural rule, not cljfmt's argument alignment: the probe is skipped.
    assert.strictEqual(indentAt(text, text.length - 1), 2);
  });
});

suite("cljfmtEngine.selectWindow", () => {
  test("deep nesting is limited to maxInner + 1 ancestors", () => {
    const text = "(a (b (c (d (e )))))";
    const win = selectWindow(text, text.indexOf("(e ") + 3, 2, WINDOW_CAP);
    assert.ok(win);
    assert.strictEqual(win.start, text.indexOf("(c"));
    assert.strictEqual(win.end, text.indexOf(")))))") + 3);
  });

  test("an oversized outer form shrinks the window inward", () => {
    let siblings = "";
    for (let i = 0; i < 200; i++) {
      siblings += `  (defn-ish f${i} [x] (println x ${i}))\n`;
    }
    const text = `(comment\n${siblings}  (let [y 1]\n))`;
    const offset = text.indexOf("(let [y 1]") + 10;
    const win = selectWindow(text, offset, 2, WINDOW_CAP);
    assert.ok(win);
    assert.strictEqual(win.start, text.indexOf("(let [y 1]"));
    // …and the capped window still yields the cljfmt answer: the `(let`
    // sits at column 2 inside the comment block, so its body is at 4.
    assert.strictEqual(indentAt(text, offset), 4);
  });

  test("unclosed windows report null", () => {
    assert.strictEqual(selectWindow("(foo (bar", 9, 2, WINDOW_CAP), null);
  });
});
