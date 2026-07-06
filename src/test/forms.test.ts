import * as assert from "assert";
import { formAtCursor, nsBefore } from "../repl/forms";

/** Splits a source with a single `|` cursor marker into text + offset. */
function at(source: string): { text: string; offset: number } {
  const offset = source.indexOf("|");
  assert.notStrictEqual(offset, -1, "test source must contain a | marker");
  return { text: source.slice(0, offset) + source.slice(offset + 1), offset };
}

/** The text of the form `formAtCursor` resolves for the `|` cursor, or null. */
function form(source: string): string | null {
  const { text, offset } = at(source);
  const range = formAtCursor(text, offset);
  return range === null ? null : text.slice(range.start, range.end);
}

suite("formAtCursor: token at cursor (rule 2)", () => {
  test("cursor inside a symbol", () => {
    assert.strictEqual(form("(+ fo|o 2)"), "foo");
  });

  test("cursor inside a keyword", () => {
    assert.strictEqual(form("(get m :ba|r)"), ":bar");
  });

  test("cursor inside a number", () => {
    assert.strictEqual(form("(+ 1 2|2)"), "22");
  });

  test("cursor immediately after a token", () => {
    assert.strictEqual(form("(+ 1 22|)"), "22");
    assert.strictEqual(form("foo| bar"), "foo");
  });

  test("cursor inside a string evaluates the whole string literal", () => {
    assert.strictEqual(form('(str "he|llo" x)'), '"hello"');
  });

  test("cursor immediately after a string's closing quote", () => {
    assert.strictEqual(form('(str "hello"| x)'), '"hello"');
  });

  test("symbols with quote and hash characters stay whole", () => {
    assert.strictEqual(form("(fo|o' 1)"), "foo'");
    assert.strictEqual(form("(let [x|# 1])"), "x#");
  });
});

suite("formAtCursor: form before cursor (rule 3)", () => {
  test("cursor right after a closing paren", () => {
    assert.strictEqual(form("(+ 1 2)|"), "(+ 1 2)");
  });

  test("nested form before cursor", () => {
    assert.strictEqual(form("(a (b c)| d)"), "(b c)");
  });

  test("vector and map before cursor", () => {
    assert.strictEqual(form("[1 2]| x"), "[1 2]");
    assert.strictEqual(form("{:a 1}| x"), "{:a 1}");
  });
});

suite("formAtCursor: form right after cursor (rule 4)", () => {
  test("cursor immediately before a token", () => {
    assert.strictEqual(form("|foo bar"), "foo");
    assert.strictEqual(form("(a |(b) c)"), "(b)");
  });

  test("sandwich: preceding form wins over following token", () => {
    assert.strictEqual(form("(foo)|bar"), "(foo)");
  });
});

suite("formAtCursor: whitespace inside a list (rule 5)", () => {
  test("cursor between siblings evaluates the enclosing form", () => {
    assert.strictEqual(form("(foo  |  bar)"), "(foo    bar)");
  });

  test("cursor in trailing whitespace of a list", () => {
    assert.strictEqual(form("(foo | )"), "(foo  )");
  });

  test("cursor before the first sibling", () => {
    assert.strictEqual(form("( | foo)"), "(  foo)");
  });

  test("innermost enclosing form wins", () => {
    assert.strictEqual(form("(outer (inner | ) x)"), "(inner  )");
  });
});

suite("formAtCursor: top-level whitespace (rule 6)", () => {
  test("walks back over whitespace to the previous top-level form", () => {
    assert.strictEqual(form("(def x 1)\n\n|"), "(def x 1)");
    assert.strictEqual(form("(def x 1)  |  (def y 2)"), "(def x 1)");
  });

  test("walks back over a line comment", () => {
    assert.strictEqual(form("(def x 1)\n;; note\n|"), "(def x 1)");
  });

  test("nothing before the cursor", () => {
    assert.strictEqual(form("   |   "), null);
    assert.strictEqual(form("|"), null);
    assert.strictEqual(form("|  (foo)"), null);
  });
});

suite("formAtCursor: reader prefixes", () => {
  test("quote, syntax-quote, unquote, deref, var", () => {
    assert.strictEqual(form("'(a b)|"), "'(a b)");
    assert.strictEqual(form("`(a b)|"), "`(a b)");
    assert.strictEqual(form("`(a ~b|)"), "~b");
    assert.strictEqual(form("`(a ~@b|s)"), "~@bs");
    assert.strictEqual(form("@state|"), "@state");
    assert.strictEqual(form("#'foo|"), "#'foo");
  });

  test("dispatch forms are whole forms", () => {
    assert.strictEqual(form("#(inc %)|"), "#(inc %)");
    assert.strictEqual(form("#{1 2}|"), "#{1 2}");
    assert.strictEqual(form('#"\\d+"|'), '#"\\d+"');
  });

  test("metadata is included with the form it annotates", () => {
    assert.strictEqual(form("^:private (def x 1)|"), "^:private (def x 1)");
  });

  test("enclosing form keeps its prefix (rule 5 inside a quoted list)", () => {
    assert.strictEqual(form("'(a | b)"), "'(a  b)");
  });

  test("#_ discard is stripped so the form itself evaluates", () => {
    assert.strictEqual(form("#_(+ 1 2)|"), "(+ 1 2)");
    assert.strictEqual(form("#_fo|o"), "foo");
  });

  test("cursor inside a discarded form still resolves inside it", () => {
    assert.strictEqual(form("#_(+ 1 |2)"), "2");
  });
});

suite("formAtCursor: comment forms", () => {
  test("inner form of (comment ...) resolves naturally", () => {
    assert.strictEqual(form("(comment (+ 1 2)|)"), "(+ 1 2)");
    assert.strictEqual(form("(comment (+ 1 |2))"), "2");
  });

  test("cursor on the comment symbol evaluates it as a token", () => {
    assert.strictEqual(form("(comm|ent (+ 1 2))"), "comment");
  });
});

suite("formAtCursor: robustness", () => {
  test("brackets inside strings are ignored", () => {
    assert.strictEqual(form('(str "(" |x)'), "x");
    assert.strictEqual(form('(str ")")|'), '(str ")")');
  });

  test("brackets inside regex literals are ignored", () => {
    assert.strictEqual(form('(re-find #"\\)" s)|'), '(re-find #"\\)" s)');
  });

  test("brackets as char literals are ignored", () => {
    assert.strictEqual(form("[\\( |x]"), "x");
    assert.strictEqual(form("[\\) \\(]|"), "[\\) \\(]");
  });

  test("brackets inside line comments are ignored", () => {
    assert.strictEqual(form("(a ; )\n b|)"), "b");
  });

  test("string escapes do not end the string", () => {
    assert.strictEqual(form('"a\\"b|c"'), '"a\\"bc"');
  });

  test("unbalanced code returns null instead of garbage", () => {
    assert.strictEqual(form("(foo (bar |"), null);
    assert.strictEqual(form("(foo | "), null);
  });

  test("unbalanced code after the cursor does not block earlier rules", () => {
    assert.strictEqual(form("(def x 1)\n|\n(foo"), "(def x 1)");
    assert.strictEqual(form("(def x 1)|\n(foo"), "(def x 1)");
    assert.strictEqual(form("(def |x 1)\n(foo"), "x");
  });

  test("stray closers are skipped", () => {
    assert.strictEqual(form(") |foo"), "foo");
  });

  test("offsets at the very start and end of the text", () => {
    assert.strictEqual(form("|(a)"), "(a)");
    assert.strictEqual(form("(a)|"), "(a)");
  });

  test("commas are whitespace", () => {
    assert.strictEqual(form("[1,, |2]"), "2");
    assert.strictEqual(form("{:a 1|,}"), "1");
    assert.strictEqual(form("{:a 1,|}"), "{:a 1,}");
  });

  test("CRLF line endings", () => {
    assert.strictEqual(form("(def x 1)\r\n|"), "(def x 1)");
  });
});

suite("nsBefore", () => {
  function ns(source: string): string | undefined {
    const { text, offset } = at(source);
    return nsBefore(text, offset);
  }

  test("plain ns form before the cursor", () => {
    assert.strictEqual(ns("(ns foo.bar)\n\n(def |x 1)"), "foo.bar");
  });

  test("ns with metadata and docstring", () => {
    assert.strictEqual(
      ns('(ns ^:dev foo.core\n  "docs"\n  (:require [x]))\n|(+ 1 2)'),
      "foo.core",
    );
  });

  test("nearest preceding ns of several wins", () => {
    assert.strictEqual(
      ns("(ns one)\n(def a 1)\n(ns two)\n(def |b 2)"),
      "two",
    );
    assert.strictEqual(ns("(ns one)\n(def |a 1)\n(ns two)"), "one");
  });

  test("no ns form", () => {
    assert.strictEqual(ns("(def |x 1)"), undefined);
  });

  test("nested ns forms are not picked up", () => {
    assert.strictEqual(ns("(defn f [] (ns fake))\n(+ |1 2)"), undefined);
  });

  test("discarded and quoted ns forms are not picked up", () => {
    assert.strictEqual(ns("#_(ns fake)\n(def |x 1)"), undefined);
    assert.strictEqual(ns("'(ns fake)\n(def |x 1)"), undefined);
    assert.strictEqual(ns("(ns real)\n#_(ns fake)\n(def |x 1)"), "real");
  });

  test("evaluating the ns form itself gets no ns param", () => {
    assert.strictEqual(ns("|(ns foo)"), undefined);
  });
});
