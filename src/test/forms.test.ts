import * as assert from "assert";
import {
  formAtCursor,
  nsBefore,
  testAtCursor,
  testRunFailed,
  testsInText,
} from "../repl/forms";

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

suite("testAtCursor", () => {
  /** Resolves the deftest for the `|` cursor: its name plus the range text. */
  function found(source: string): { name: string; text: string } | null {
    const { text, offset } = at(source);
    const result = testAtCursor(text, offset);
    return result === null
      ? null
      : { name: result.name, text: text.slice(result.range.start, result.range.end) };
  }

  test("cursor inside the deftest body", () => {
    assert.deepStrictEqual(found("(deftest my-test\n  (is (= 1 |1)))"), {
      name: "my-test",
      text: "(deftest my-test\n  (is (= 1 1)))",
    });
  });

  test("cursor on the test name", () => {
    assert.deepStrictEqual(found("(deftest my-|test\n  (is true))"), {
      name: "my-test",
      text: "(deftest my-test\n  (is true))",
    });
  });

  test("cursor immediately after the closing paren", () => {
    assert.deepStrictEqual(found("(deftest my-test (is true))|"), {
      name: "my-test",
      text: "(deftest my-test (is true))",
    });
  });

  test("cursor in whitespace after the deftest", () => {
    assert.deepStrictEqual(found("(deftest my-test (is true))\n\n|"), {
      name: "my-test",
      text: "(deftest my-test (is true))",
    });
  });

  test("qualified deftest heads", () => {
    assert.deepStrictEqual(found("(t/deftest foo (is |true))"), {
      name: "foo",
      text: "(t/deftest foo (is true))",
    });
    assert.deepStrictEqual(found("(clojure.test/deftest foo (is |true))"), {
      name: "foo",
      text: "(clojure.test/deftest foo (is true))",
    });
  });

  test("metadata on the test name is skipped", () => {
    assert.deepStrictEqual(found("(deftest ^:integration foo (is |true))"), {
      name: "foo",
      text: "(deftest ^:integration foo (is true))",
    });
  });

  test("cursor inside a non-deftest top-level form", () => {
    assert.strictEqual(found("(ns foo.|bar-test)"), null);
    assert.strictEqual(
      found("(deftest a (is true))\n(defn helper [] |1)\n(deftest b (is true))"),
      null,
    );
  });

  test("cursor in whitespace after a non-deftest form", () => {
    assert.strictEqual(found("(defn helper [] 1)\n|"), null);
  });

  test("head that merely contains deftest does not match", () => {
    assert.strictEqual(found("(deftest-like foo (is |true))"), null);
  });

  test("unbalanced deftest", () => {
    assert.strictEqual(found("(deftest my-test (is |true)"), null);
  });

  test("empty buffer and missing name", () => {
    assert.strictEqual(found("  |  "), null);
    assert.strictEqual(found("(deftest|)"), null);
    assert.strictEqual(found("(deftest [not-a-name] (is |true))"), null);
  });

  test("discarded children are skipped when locating head and name", () => {
    assert.deepStrictEqual(found("(deftest #_old actual (is |true))"), {
      name: "actual",
      text: "(deftest #_old actual (is true))",
    });
    assert.deepStrictEqual(found("(#_wat deftest foo (is |true))"), {
      name: "foo",
      text: "(#_wat deftest foo (is true))",
    });
  });

  test("metadata before a discard marker still skips the child", () => {
    assert.deepStrictEqual(found("(deftest ^:m #_old actual (is |true))"), {
      name: "actual",
      text: "(deftest ^:m #_old actual (is true))",
    });
  });

  test("thousands of discarded children do not overflow the stack", () => {
    const source = "(deftest " + "#_x ".repeat(10000) + "my-test (is |true))";
    const { text, offset } = at(source);
    assert.strictEqual(testAtCursor(text, offset)?.name, "my-test");
  });

  test("nested #_#_ markers discard two children", () => {
    assert.deepStrictEqual(
      found("(deftest #_#_old also-old actual (is |true))"),
      {
        name: "actual",
        text: "(deftest #_#_old also-old actual (is true))",
      },
    );
  });

  test("every leading discard marker is stripped from the range", () => {
    assert.deepStrictEqual(found("#_#_(deftest foo (is |true)) (bar)"), {
      name: "foo",
      text: "(deftest foo (is true))",
    });
    assert.deepStrictEqual(found("^:a #_(deftest foo (is |true))"), {
      name: "foo",
      text: "(deftest foo (is true))",
    });
  });

  test("metadata on the deftest list itself is allowed", () => {
    assert.deepStrictEqual(found("^:focused (deftest foo (is |true))"), {
      name: "foo",
      text: "^:focused (deftest foo (is true))",
    });
  });

  test("discarded deftest resolves with the marker stripped", () => {
    assert.deepStrictEqual(found("#_(deftest foo (is |true))"), {
      name: "foo",
      text: "(deftest foo (is true))",
    });
  });

  test("quoted deftest does not resolve", () => {
    assert.strictEqual(found("'(deftest foo (is |true))"), null);
    assert.strictEqual(found("`(deftest foo (is |true))"), null);
  });
});

suite("testsInText", () => {
  /** Every enumerated test as `{ name, text-of-range }`, in buffer order. */
  function tests(text: string): { name: string; text: string }[] {
    return testsInText(text).map((found) => ({
      name: found.name,
      text: text.slice(found.range.start, found.range.end),
    }));
  }

  test("every top-level deftest in buffer order", () => {
    assert.deepStrictEqual(
      tests("(ns app-test)\n(deftest a (is true))\n(deftest b\n  (is false))\n"),
      [
        { name: "a", text: "(deftest a (is true))" },
        { name: "b", text: "(deftest b\n  (is false))" },
      ],
    );
  });

  test("non-deftest forms are skipped", () => {
    assert.deepStrictEqual(
      tests("(ns app-test)\n(defn helper [] 1)\n(deftest a (is true))\n(def x 1)"),
      [{ name: "a", text: "(deftest a (is true))" }],
    );
  });

  test("qualified deftest heads are included", () => {
    assert.deepStrictEqual(
      tests("(t/deftest a (is true))\n(clojure.test/deftest b (is true))"),
      [
        { name: "a", text: "(t/deftest a (is true))" },
        { name: "b", text: "(clojure.test/deftest b (is true))" },
      ],
    );
  });

  test("metadata on the deftest is included, metadata on the name too", () => {
    assert.deepStrictEqual(
      tests("^:focused (deftest a (is true))\n(deftest ^:integration b (is true))"),
      [
        { name: "a", text: "^:focused (deftest a (is true))" },
        { name: "b", text: "(deftest ^:integration b (is true))" },
      ],
    );
  });

  test("discarded deftests are excluded — a load-file never defines them", () => {
    assert.deepStrictEqual(
      tests("#_(deftest gone (is true))\n(deftest a (is true))"),
      [{ name: "a", text: "(deftest a (is true))" }],
    );
    assert.deepStrictEqual(tests("^:m #_(deftest gone (is true))"), []);
    assert.deepStrictEqual(tests("#_#_(deftest gone (is true)) (deftest also (is true))"), []);
  });

  test("quoted deftests are excluded", () => {
    assert.deepStrictEqual(tests("'(deftest a (is true))\n`(deftest b (is true))"), []);
  });

  test("discarded children inside a deftest still resolve the name", () => {
    assert.deepStrictEqual(tests("(deftest #_old actual (is true))"), [
      { name: "actual", text: "(deftest #_old actual (is true))" },
    ]);
  });

  test("a deftest with no name is skipped", () => {
    assert.deepStrictEqual(tests("(deftest)\n(deftest a (is true))"), [
      { name: "a", text: "(deftest a (is true))" },
    ]);
    assert.deepStrictEqual(tests("(deftest [not-a-name] (is true))"), []);
  });

  test("an unbalanced tail degrades to the tests read so far", () => {
    assert.deepStrictEqual(tests("(deftest a (is true))\n(deftest b (is true"), [
      { name: "a", text: "(deftest a (is true))" },
    ]);
    assert.deepStrictEqual(tests("(deftest a (is true"), []);
  });

  test("empty and comment-only buffers", () => {
    assert.deepStrictEqual(tests(""), []);
    assert.deepStrictEqual(tests("  ;; nothing here\n"), []);
  });

  test("stray top-level closers do not stop enumeration", () => {
    assert.deepStrictEqual(tests(")\n(deftest a (is true))"), [
      { name: "a", text: "(deftest a (is true))" },
    ]);
  });
});

suite("testRunFailed", () => {
  test("all passing summary", () => {
    assert.strictEqual(
      testRunFailed("{:test 1, :pass 2, :fail 0, :error 0, :type :summary}"),
      false,
    );
  });

  test("failures and errors", () => {
    assert.strictEqual(
      testRunFailed("{:test 1, :pass 0, :fail 1, :error 0, :type :summary}"),
      true,
    );
    assert.strictEqual(
      testRunFailed("{:test 1, :pass 0, :fail 0, :error 2, :type :summary}"),
      true,
    );
    assert.strictEqual(
      testRunFailed("{:test 5, :pass 0, :fail 10, :error 0, :type :summary}"),
      true,
    );
  });

  test("fallback counters map without :type", () => {
    assert.strictEqual(testRunFailed("{:test 1, :pass 0, :fail 1, :error 0}"), true);
    assert.strictEqual(testRunFailed("{:test 1, :pass 1, :fail 0, :error 0}"), false);
  });

  test("no value or non-map value", () => {
    assert.strictEqual(testRunFailed(undefined), false);
    assert.strictEqual(testRunFailed("nil"), false);
  });
});
