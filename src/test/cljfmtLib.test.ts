import * as assert from "assert";
import {
  cljfmtVersion,
  defaultConfig,
  mergeConfig,
  readConfig,
  reformatString,
} from "@abogoyavlensky/cljfmt-js";

// Smoke tests for the bundled cljfmt-js build: the dependency resolves, its
// typings match runtime, and the core behaviors the engine relies on hold.
suite("cljfmt-js dependency", () => {
  test("bundles cljfmt 0.16.5", () => {
    assert.strictEqual(cljfmtVersion, "0.16.5");
  });

  test("reformats with community defaults", () => {
    assert.strictEqual(
      reformatString("(let [a 1]\n(inc a))"),
      "(let [a 1]\n  (inc a))",
    );
  });

  test("config changes function-argument indentation", () => {
    const cursive = readConfig("{:function-arguments-indentation :cursive}");
    assert.strictEqual(reformatString("(foo\nbar)"), "(foo\n bar)");
    assert.strictEqual(reformatString("(foo\nbar)", cursive), "(foo\n  bar)");
  });

  test("mergeConfig lets the override win", () => {
    const cursive = readConfig("{:function-arguments-indentation :cursive}");
    const merged = mergeConfig(defaultConfig, cursive);
    assert.strictEqual(reformatString("(foo\nbar)", merged), "(foo\n  bar)");
  });

  test("invalid config EDN throws", () => {
    assert.throws(() => readConfig("{oops"));
  });

  test("unparseable source throws", () => {
    assert.throws(() => reformatString("(foo"));
  });
});
