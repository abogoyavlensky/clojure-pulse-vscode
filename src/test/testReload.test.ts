import * as assert from "assert";
import {
  parseReloadOutcome,
  PRIME_EXPR,
  RELOAD_EXPR,
} from "../repl/testReload";

suite("parseReloadOutcome", () => {
  test("the no-reload keyword means clj-reload is unavailable", () => {
    assert.deepStrictEqual(
      parseReloadOutcome({
        value: ":clojure-pulse/no-reload",
        namespaceNotFound: false,
      }),
      { kind: "unavailable" },
    );
  });

  test("an err means the probe itself broke, so unavailable", () => {
    assert.deepStrictEqual(
      parseReloadOutcome({
        err: "Unable to resolve symbol",
        namespaceNotFound: false,
      }),
      { kind: "unavailable" },
    );
  });

  test("a loaded count reads as reloaded", () => {
    assert.deepStrictEqual(
      parseReloadOutcome({ value: "{:loaded 3}", namespaceNotFound: false }),
      { kind: "reloaded", loaded: 3 },
    );
    assert.deepStrictEqual(
      parseReloadOutcome({ value: "{:loaded 0}", namespaceNotFound: false }),
      { kind: "reloaded", loaded: 0 },
    );
  });

  test("a value without a count still reads as reloaded", () => {
    assert.deepStrictEqual(
      parseReloadOutcome({ value: "nil", namespaceNotFound: false }),
      { kind: "reloaded", loaded: 0 },
    );
  });

  test("a failed namespace carries its message", () => {
    assert.deepStrictEqual(
      parseReloadOutcome({
        value:
          '{:failed app.core, :message "Syntax error compiling at (src/app/core.clj:3:1).: Unable to resolve symbol: x in this context"}',
        namespaceNotFound: false,
      }),
      {
        kind: "failed",
        ns: "app.core",
        message:
          "Syntax error compiling at (src/app/core.clj:3:1).: Unable to resolve symbol: x in this context",
      },
    );
  });

  test("escapes in the message are unescaped", () => {
    assert.deepStrictEqual(
      parseReloadOutcome({
        value: '{:failed app.core, :message "expected \\"x\\" here"}',
        namespaceNotFound: false,
      }),
      { kind: "failed", ns: "app.core", message: 'expected "x" here' },
    );
  });

  test("a failed namespace without a message falls back to the raw value", () => {
    assert.deepStrictEqual(
      parseReloadOutcome({
        value: "{:failed app.core}",
        namespaceNotFound: false,
      }),
      { kind: "failed", ns: "app.core", message: "{:failed app.core}" },
    );
  });

  test("a nil namespace means clj-reload threw before it named one", () => {
    assert.deepStrictEqual(
      parseReloadOutcome({
        value: '{:failed nil, :message "Unmatched delimiter: )"}',
        namespaceNotFound: false,
      }),
      { kind: "failed", ns: "?", message: "Unmatched delimiter: )" },
    );
  });

  test("a failed value the regexes cannot read falls back", () => {
    assert.deepStrictEqual(
      parseReloadOutcome({ value: "{:failed}", namespaceNotFound: false }),
      { kind: "failed", ns: "?", message: "{:failed}" },
    );
  });

  test("no value at all reads as reloaded", () => {
    assert.deepStrictEqual(parseReloadOutcome({ namespaceNotFound: false }), {
      kind: "reloaded",
      loaded: 0,
    });
  });
});

suite("reload expressions", () => {
  test("the reload expression resolves clj-reload and does not throw", () => {
    assert.ok(RELOAD_EXPR.includes("(resolve 'clj-reload.core/reload)"));
    assert.ok(RELOAD_EXPR.includes("{:throw false}"));
    // A scan failure has to come back as a value, not as an err.
    assert.ok(RELOAD_EXPR.includes("(catch Exception e"));
  });

  test("the prime expression requires clj-reload", () => {
    assert.ok(PRIME_EXPR.includes("(require 'clj-reload.core)"));
  });
});
