import * as assert from "assert";
import {
  parseCustomReplCommands,
  presentCustomCommand,
} from "../repl/customCommands";

suite("parseCustomReplCommands", () => {
  test("accepts entries with a name and code, trimming the name", () => {
    const { commands, warnings } = parseCustomReplCommands([
      { name: "  reset  ", code: "(user/reset)" },
    ]);

    assert.deepStrictEqual(warnings, []);
    assert.deepStrictEqual(commands, [{ name: "reset", code: "(user/reset)" }]);
  });

  test("keeps code verbatim, whitespace included", () => {
    const code = "  (do\n  (user/stop)\n  (user/start))\n";
    const { commands } = parseCustomReplCommands([{ name: "restart", code }]);
    assert.strictEqual(commands[0].code, code);
  });

  test("returns nothing for missing settings", () => {
    assert.deepStrictEqual(parseCustomReplCommands(undefined), {
      commands: [],
      warnings: [],
    });
    assert.deepStrictEqual(parseCustomReplCommands(null), {
      commands: [],
      warnings: [],
    });
  });

  test("warns once for a non-array value", () => {
    const { commands, warnings } = parseCustomReplCommands({ name: "reset" });
    assert.deepStrictEqual(commands, []);
    assert.strictEqual(warnings.length, 1);
  });

  test("skips non-object items with a warning naming their position", () => {
    const { commands, warnings } = parseCustomReplCommands([
      "reset",
      { name: "ok", code: "(user/reset)" },
    ]);
    assert.strictEqual(commands.length, 1);
    assert.strictEqual(commands[0].name, "ok");
    assert.strictEqual(warnings.length, 1);
    assert.ok(warnings[0].includes("#1"), warnings[0]);
  });

  test("rejects entries without a usable name", () => {
    const { commands, warnings } = parseCustomReplCommands([
      { code: "(user/reset)" },
      { name: "   ", code: "(user/reset)" },
      { name: 7, code: "(user/reset)" },
    ]);
    assert.deepStrictEqual(commands, []);
    assert.strictEqual(warnings.length, 3);
    assert.ok(warnings.every((w) => /name/i.test(w)), warnings.join(" | "));
  });

  test("rejects entries without usable code, naming the entry", () => {
    const { commands, warnings } = parseCustomReplCommands([
      { name: "empty" },
      { name: "blank", code: "   " },
      { name: "wrong", code: 42 },
    ]);
    assert.deepStrictEqual(commands, []);
    assert.strictEqual(warnings.length, 3);
    assert.ok(warnings.every((w) => /code/i.test(w)), warnings.join(" | "));
    assert.ok(warnings[0].includes("empty"), warnings[0]);
  });

  test("skips duplicate names, keeping the first valid entry", () => {
    const { commands, warnings } = parseCustomReplCommands([
      { name: "reset", code: "(user/reset)" },
      { name: "reset", code: "(user/other)" },
    ]);
    assert.strictEqual(commands.length, 1);
    assert.strictEqual(commands[0].code, "(user/reset)");
    assert.ok(/duplicate/i.test(warnings[0]), warnings[0]);
  });

  test("a skipped entry does not reserve its name", () => {
    const { commands, warnings } = parseCustomReplCommands([
      { name: "reset" },
      { name: "reset", code: "(user/reset)" },
    ]);
    assert.strictEqual(commands.length, 1);
    assert.strictEqual(commands[0].code, "(user/reset)");
    assert.strictEqual(warnings.length, 1);
  });

  test("keeps valid entries alongside invalid ones", () => {
    const { commands, warnings } = parseCustomReplCommands([
      { name: "broken" },
      { name: "reset", code: "(user/reset)" },
    ]);
    assert.deepStrictEqual(
      commands.map((c) => c.name),
      ["reset"],
    );
    assert.strictEqual(warnings.length, 1);
  });
});

suite("presentCustomCommand", () => {
  test("shows the name with the code as the description and tooltip", () => {
    const view = presentCustomCommand({ name: "reset", code: "(user/reset)" });
    assert.deepStrictEqual(view, {
      label: "reset",
      description: "(user/reset)",
      tooltip: "(user/reset)",
      contextValue: "customReplCommand",
    });
  });

  test("describes multi-line code by its first line, tooltip keeps it all", () => {
    const code = "(do\n  (user/stop)\n  (user/start))";
    const view = presentCustomCommand({ name: "restart", code });
    assert.strictEqual(view.description, "(do");
    assert.strictEqual(view.tooltip, code);
  });

  test("trims the description's line", () => {
    const view = presentCustomCommand({
      name: "reset",
      code: "  (user/reset)  \n(println :done)",
    });
    assert.strictEqual(view.description, "(user/reset)");
  });
});
