import * as assert from "assert";
import {
  formValuesFor,
  removeEntry,
  ReplFormValues,
  toConfigEntry,
  upsertEntry,
  validateFormValues,
} from "../repl/replConfigEdit";

/** Stands in for whatever the project's build file prefills. */
const COMMAND = "clojure -M:clojure-pulse/nrepl";

/** Add-mode defaults with a few fields overridden — what the form posts back. */
function values(overrides: Partial<ReplFormValues> = {}): ReplFormValues {
  return { ...formValuesFor(undefined, COMMAND), ...overrides };
}

suite("formValuesFor", () => {
  test("adding starts from the project's defaults", () => {
    assert.deepStrictEqual(formValuesFor(undefined, COMMAND), {
      name: "",
      type: "create",
      command: COMMAND,
      cwd: ".",
      host: "localhost",
      port: ".nrepl-port",
    });
  });

  test("fills a create entry, defaulting what it omits", () => {
    assert.deepStrictEqual(
      formValuesFor(
        { name: "dev", type: "create", command: "clj -M:repl", cwd: "modules/api" },
        COMMAND,
      ),
      {
        name: "dev",
        type: "create",
        command: "clj -M:repl",
        cwd: "modules/api",
        host: "localhost",
        port: ".nrepl-port",
      },
    );
  });

  test("fills a connect entry, showing a numeric port as text", () => {
    assert.deepStrictEqual(
      formValuesFor({ name: "staging", type: "connect", host: "10.0.0.1", port: 7888 }, COMMAND),
      {
        name: "staging",
        type: "connect",
        command: COMMAND,
        cwd: ".",
        host: "10.0.0.1",
        port: "7888",
      },
    );
  });

  test("shows the name the tree shows", () => {
    assert.strictEqual(
      formValuesFor({ name: "  dev  ", type: "connect", port: 7888 }, COMMAND).name,
      "dev",
    );
  });

  test("prefills the command of an entry that has none", () => {
    assert.strictEqual(formValuesFor({ name: "dev", type: "create" }, COMMAND).command, COMMAND);
    assert.strictEqual(formValuesFor({ name: "dev", type: "create", command: "  " }, COMMAND).command, COMMAND);
  });

  test("an entry with an unusable type opens as create", () => {
    assert.strictEqual(formValuesFor({ name: "dev", type: "spawn" }, COMMAND).type, "create");
    assert.strictEqual(formValuesFor({ name: "dev" }, COMMAND).type, "create");
  });
});

suite("validateFormValues", () => {
  test("accepts a complete entry of either type", () => {
    assert.deepStrictEqual(validateFormValues(values({ name: "dev" }), []), {});
    assert.deepStrictEqual(
      validateFormValues(values({ name: "local", type: "connect" }), []),
      {},
    );
  });

  test("requires a name", () => {
    assert.ok(validateFormValues(values({ name: "   " }), []).name);
  });

  test("rejects a name another entry already uses", () => {
    const entries = [{ name: "dev", type: "connect", port: 7888 }];
    const error = validateFormValues(values({ name: "dev" }), entries).name;
    assert.ok(error, "expected a name conflict");
    assert.ok(error.includes("dev"), error);
    // Trailing spaces do not buy a second "dev": the tree would show one name.
    assert.ok(validateFormValues(values({ name: " dev " }), entries).name);
  });

  test("an entry being edited keeps its own name", () => {
    const entries = [
      { name: "dev", type: "connect", port: 7888 },
      { name: "other", type: "connect", port: 7889 },
    ];
    assert.strictEqual(validateFormValues(values({ name: "dev" }), entries, "dev").name, undefined);
    assert.ok(validateFormValues(values({ name: "other" }), entries, "dev").name);
  });

  test("a broken entry cannot block a name", () => {
    // The parser skips a `create` with no command, so it never reaches the
    // tree — and must not reserve "dev" either.
    const entries = [{ name: "dev", type: "create" }];
    assert.strictEqual(validateFormValues(values({ name: "dev" }), entries).name, undefined);
  });

  test("requires a command for create only", () => {
    assert.ok(validateFormValues(values({ name: "dev", command: "  " }), []).command);
    assert.strictEqual(
      validateFormValues(values({ name: "dev", type: "connect", command: "" }), []).command,
      undefined,
    );
  });

  test("checks the port for connect only", () => {
    assert.ok(validateFormValues(values({ name: "dev", type: "connect", port: "70000" }), []).port);
    assert.ok(validateFormValues(values({ name: "dev", type: "connect", port: "  " }), []).port);
    assert.strictEqual(
      validateFormValues(values({ name: "dev", type: "connect", port: "target/nrepl.port" }), []).port,
      undefined,
    );
    assert.strictEqual(validateFormValues(values({ name: "dev", port: "0" }), []).port, undefined);
  });
});

suite("toConfigEntry", () => {
  test("writes a create entry without the default cwd", () => {
    assert.deepStrictEqual(toConfigEntry(values({ name: "dev", command: "clj -M:repl" })), {
      name: "dev",
      type: "create",
      command: "clj -M:repl",
    });
  });

  test("keeps a cwd of its own", () => {
    assert.deepStrictEqual(
      toConfigEntry(values({ name: "api", command: "clj -M:repl", cwd: "modules/api" })),
      { name: "api", type: "create", command: "clj -M:repl", cwd: "modules/api" },
    );
  });

  test("writes a connect entry without the default host", () => {
    assert.deepStrictEqual(
      toConfigEntry(values({ name: "local", type: "connect", port: "7888" })),
      { name: "local", type: "connect", port: 7888 },
    );
  });

  test("writes a numeric port as a number and a path as a string", () => {
    assert.strictEqual(
      toConfigEntry(values({ name: "a", type: "connect", port: " 7888 " })).port,
      7888,
    );
    assert.strictEqual(
      toConfigEntry(values({ name: "a", type: "connect", port: ".nrepl-port" })).port,
      ".nrepl-port",
    );
  });

  test("keeps a host of its own", () => {
    assert.deepStrictEqual(
      toConfigEntry(values({ name: "remote", type: "connect", host: "10.0.0.1", port: "7888" })),
      { name: "remote", type: "connect", host: "10.0.0.1", port: 7888 },
    );
  });

  test("trims what the user typed", () => {
    assert.deepStrictEqual(
      toConfigEntry(values({ name: "  dev  ", command: "  clj -M:repl  ", cwd: "  api  " })),
      { name: "dev", type: "create", command: "clj -M:repl", cwd: "api" },
    );
  });

  test("preserves keys this version does not know about", () => {
    const original = { name: "dev", type: "create", command: "clj", note: "keep me" };
    assert.deepStrictEqual(
      toConfigEntry(values({ name: "dev", command: "clj -M:repl" }), original),
      { name: "dev", type: "create", command: "clj -M:repl", note: "keep me" },
    );
  });

  test("drops the other type's keys when the type changed", () => {
    const created = { name: "dev", type: "create", command: "clj", cwd: "api" };
    assert.deepStrictEqual(
      toConfigEntry(values({ name: "dev", type: "connect", port: "7888" }), created),
      { name: "dev", type: "connect", port: 7888 },
    );

    const connected = { name: "dev", type: "connect", host: "10.0.0.1", port: 7888 };
    assert.deepStrictEqual(
      toConfigEntry(values({ name: "dev", command: "clj -M:repl" }), connected),
      { name: "dev", type: "create", command: "clj -M:repl" },
    );
  });

  test("ignores an original that is not an object", () => {
    assert.deepStrictEqual(toConfigEntry(values({ name: "dev", command: "clj" }), "junk"), {
      name: "dev",
      type: "create",
      command: "clj",
    });
  });
});

suite("upsertEntry", () => {
  const dev = { name: "dev", type: "create", command: "clj -M:repl" };

  test("replaces the entry with the original name, in place", () => {
    const entries = [
      { name: "a", type: "connect", port: 7888 },
      { name: "dev", type: "create", command: "old" },
      { name: "b", type: "connect", port: 7889 },
    ];
    assert.deepStrictEqual(upsertEntry(entries, dev, "dev"), [entries[0], dev, entries[2]]);
  });

  test("matches an original name that needed trimming", () => {
    const entries = [{ name: "  dev  ", type: "create", command: "old" }];
    assert.deepStrictEqual(upsertEntry(entries, dev, "dev"), [dev]);
  });

  test("replaces only the first of two entries sharing a name", () => {
    const shadowed = { name: "dev", type: "connect", port: 7999 };
    const entries = [{ name: "dev", type: "create", command: "old" }, shadowed];
    assert.deepStrictEqual(upsertEntry(entries, dev, "dev"), [dev, shadowed]);
  });

  test("appends when the original entry is gone", () => {
    const entries = [{ name: "a", type: "connect", port: 7888 }];
    assert.deepStrictEqual(upsertEntry(entries, dev, "dev"), [entries[0], dev]);
  });

  test("appends a new entry", () => {
    const entries = [{ name: "a", type: "connect", port: 7888 }];
    assert.deepStrictEqual(upsertEntry(entries, dev), [entries[0], dev]);
  });

  test("leaves entries it did not match alone, non-objects included", () => {
    const entries = ["junk", 7, null, { name: "dev", type: "create", command: "old" }, []];
    assert.deepStrictEqual(upsertEntry(entries, dev, "dev"), [
      "junk",
      7,
      null,
      dev,
      entries[4],
    ]);
  });

  test("does not touch the array it was given", () => {
    const entries: unknown[] = [{ name: "dev", type: "create", command: "old" }];
    const before = [...entries];
    upsertEntry(entries, dev, "dev");
    assert.deepStrictEqual(entries, before);
  });
});

suite("removeEntry", () => {
  test("drops every entry with that name, duplicates included", () => {
    const entries = [
      { name: "a", type: "connect", port: 7888 },
      { name: "dev", type: "create", command: "clj" },
      { name: "  dev  ", type: "connect", port: 7999 },
    ];
    assert.deepStrictEqual(removeEntry(entries, "dev"), [entries[0]]);
  });

  test("leaves everything else in place, non-objects included", () => {
    const entries = ["junk", 7, null, { name: "dev", type: "create", command: "clj" }];
    assert.deepStrictEqual(removeEntry(entries, "dev"), ["junk", 7, null]);
    assert.deepStrictEqual(removeEntry(entries, "missing"), entries);
  });

  test("does not touch the array it was given", () => {
    const entries: unknown[] = [{ name: "dev", type: "create", command: "clj" }];
    const before = [...entries];
    removeEntry(entries, "dev");
    assert.deepStrictEqual(entries, before);
  });
});
