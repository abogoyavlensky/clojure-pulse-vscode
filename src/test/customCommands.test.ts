import * as assert from "assert";
import {
  commandFormValuesFor,
  findCommandEntry,
  parseCustomReplCommands,
  presentCustomCommand,
  removeCommandEntry,
  toCommandEntry,
  upsertCommandEntry,
  validateCommandFormValues,
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

suite("commandFormValuesFor", () => {
  test("adding starts empty", () => {
    assert.deepStrictEqual(commandFormValuesFor(undefined), { name: "", code: "" });
  });

  test("fills an entry's values, showing the name the pane shows", () => {
    assert.deepStrictEqual(
      commandFormValuesFor({ name: "  reset  ", code: "(user/reset)" }),
      { name: "reset", code: "(user/reset)" },
    );
  });

  test("missing fields fall back to empty strings", () => {
    assert.deepStrictEqual(commandFormValuesFor({ name: "reset" }), {
      name: "reset",
      code: "",
    });
    assert.deepStrictEqual(commandFormValuesFor({ code: 42 }), { name: "", code: "" });
    assert.deepStrictEqual(commandFormValuesFor("junk"), { name: "", code: "" });
  });
});

suite("validateCommandFormValues", () => {
  test("accepts a complete command", () => {
    assert.deepStrictEqual(
      validateCommandFormValues({ name: "reset", code: "(user/reset)" }, []),
      {},
    );
  });

  test("requires a name", () => {
    assert.ok(validateCommandFormValues({ name: "   ", code: "(user/reset)" }, []).name);
  });

  test("requires non-blank code", () => {
    assert.ok(validateCommandFormValues({ name: "reset", code: "  " }, []).code);
    assert.ok(validateCommandFormValues({ name: "reset", code: "" }, []).code);
  });

  test("rejects a name another command already uses", () => {
    const entries = [{ name: "reset", code: "(user/reset)" }];
    const error = validateCommandFormValues(
      { name: "reset", code: "(user/other)" },
      entries,
    ).name;
    assert.ok(error, "expected a name conflict");
    assert.ok(error.includes("reset"), error);
    // Trailing spaces do not buy a second "reset": the pane shows one name.
    assert.ok(
      validateCommandFormValues({ name: " reset ", code: "(x)" }, entries).name,
    );
  });

  test("an entry being edited keeps its own name", () => {
    const entries = [
      { name: "reset", code: "(user/reset)" },
      { name: "stop", code: "(user/stop)" },
    ];
    assert.strictEqual(
      validateCommandFormValues({ name: "reset", code: "(x)" }, entries, "reset").name,
      undefined,
    );
    assert.ok(
      validateCommandFormValues({ name: "stop", code: "(x)" }, entries, "reset").name,
    );
  });

  test("a broken entry cannot block a name", () => {
    // The parser skips an entry with no code, so it never reaches the pane —
    // and must not reserve "reset" either.
    const entries = [{ name: "reset" }];
    assert.strictEqual(
      validateCommandFormValues({ name: "reset", code: "(x)" }, entries).name,
      undefined,
    );
  });
});

suite("toCommandEntry", () => {
  test("trims the name and keeps the code as typed", () => {
    assert.deepStrictEqual(
      toCommandEntry({ name: "  reset  ", code: "  (user/reset)\n" }),
      { name: "reset", code: "  (user/reset)\n" },
    );
  });

  test("preserves keys this version does not know about", () => {
    const original = { name: "reset", code: "(old)", note: "keep me" };
    assert.deepStrictEqual(toCommandEntry({ name: "reset", code: "(new)" }, original), {
      name: "reset",
      code: "(new)",
      note: "keep me",
    });
  });

  test("ignores an original that is not an object", () => {
    assert.deepStrictEqual(toCommandEntry({ name: "reset", code: "(x)" }, "junk"), {
      name: "reset",
      code: "(x)",
    });
  });
});

suite("upsertCommandEntry", () => {
  const reset = { name: "reset", code: "(user/reset)" };

  test("replaces the entry with the original name, in place", () => {
    const entries = [
      { name: "a", code: "(a)" },
      { name: "reset", code: "(old)" },
      { name: "b", code: "(b)" },
    ];
    assert.deepStrictEqual(upsertCommandEntry(entries, reset, "reset"), [
      entries[0],
      reset,
      entries[2],
    ]);
  });

  test("matches an original name that needed trimming", () => {
    const entries = [{ name: "  reset  ", code: "(old)" }];
    assert.deepStrictEqual(upsertCommandEntry(entries, reset, "reset"), [reset]);
  });

  test("replaces only the first of two entries sharing a name", () => {
    const shadowed = { name: "reset", code: "(shadowed)" };
    const entries = [{ name: "reset", code: "(old)" }, shadowed];
    assert.deepStrictEqual(upsertCommandEntry(entries, reset, "reset"), [
      reset,
      shadowed,
    ]);
  });

  test("replaces the entry the pane is showing, not a broken namesake before it", () => {
    // The parser skips the code-less entry and shows the one behind it;
    // renaming must not leave that one configured.
    const broken = { name: "reset" };
    const entries = [broken, { name: "reset", code: "(user/reset)" }];
    assert.deepStrictEqual(upsertCommandEntry(entries, reset, "reset"), [
      broken,
      reset,
    ]);
  });

  test("falls back to the first namesake when none of them parses", () => {
    const entries = [{ name: "reset" }, { name: "a", code: "(a)" }];
    assert.deepStrictEqual(upsertCommandEntry(entries, reset, "reset"), [
      reset,
      entries[1],
    ]);
  });

  test("appends when the original entry is gone", () => {
    const entries = [{ name: "a", code: "(a)" }];
    assert.deepStrictEqual(upsertCommandEntry(entries, reset, "reset"), [
      entries[0],
      reset,
    ]);
  });

  test("appends a new entry", () => {
    const entries = [{ name: "a", code: "(a)" }];
    assert.deepStrictEqual(upsertCommandEntry(entries, reset), [entries[0], reset]);
  });

  test("leaves entries it did not match alone, non-objects included", () => {
    const entries = ["junk", 7, null, { name: "reset", code: "(old)" }, []];
    assert.deepStrictEqual(upsertCommandEntry(entries, reset, "reset"), [
      "junk",
      7,
      null,
      reset,
      entries[4],
    ]);
  });

  test("does not touch the array it was given", () => {
    const entries: unknown[] = [{ name: "reset", code: "(old)" }];
    const before = [...entries];
    upsertCommandEntry(entries, reset, "reset");
    assert.deepStrictEqual(entries, before);
  });
});

suite("findCommandEntry", () => {
  test("returns the entry the pane is showing", () => {
    const broken = { name: "reset" };
    const shown = { name: "reset", code: "(user/reset)" };
    assert.strictEqual(findCommandEntry([broken, shown], "reset"), shown);
    assert.strictEqual(findCommandEntry(["junk", shown], "reset"), shown);
  });

  test("has nothing for a name that is not configured", () => {
    assert.strictEqual(findCommandEntry([{ name: "a", code: "(a)" }], "reset"), undefined);
    assert.strictEqual(findCommandEntry([], "reset"), undefined);
  });
});

suite("removeCommandEntry", () => {
  test("drops every entry with that name, duplicates included", () => {
    const entries = [
      { name: "a", code: "(a)" },
      { name: "reset", code: "(user/reset)" },
      { name: "  reset  ", code: "(other)" },
    ];
    assert.deepStrictEqual(removeCommandEntry(entries, "reset"), [entries[0]]);
  });

  test("leaves everything else in place, non-objects included", () => {
    const entries = ["junk", 7, null, { name: "reset", code: "(x)" }];
    assert.deepStrictEqual(removeCommandEntry(entries, "reset"), ["junk", 7, null]);
    assert.deepStrictEqual(removeCommandEntry(entries, "missing"), entries);
  });

  test("does not touch the array it was given", () => {
    const entries: unknown[] = [{ name: "reset", code: "(x)" }];
    const before = [...entries];
    removeCommandEntry(entries, "reset");
    assert.deepStrictEqual(entries, before);
  });
});
