import * as assert from "assert";
import {
  normalizeProjectPath,
  parseProjects,
  toServerConfig,
  withToggled,
} from "../projects";

suite("normalizeProjectPath", () => {
  test("strips ./ prefixes, trailing slashes, and whitespace", () => {
    assert.strictEqual(normalizeProjectPath(" apps/backend "), "apps/backend");
    assert.strictEqual(normalizeProjectPath("./apps/backend"), "apps/backend");
    assert.strictEqual(normalizeProjectPath("apps/backend/"), "apps/backend");
    assert.strictEqual(normalizeProjectPath("./apps/backend/"), "apps/backend");
  });

  test("backslash separators normalize to forward slashes", () => {
    assert.strictEqual(normalizeProjectPath("apps\\backend"), "apps/backend");
    assert.strictEqual(normalizeProjectPath(".\\apps\\backend\\"), "apps/backend");
  });

  test("root spellings all normalize to '.'", () => {
    assert.strictEqual(normalizeProjectPath("."), ".");
    assert.strictEqual(normalizeProjectPath("./"), ".");
    assert.strictEqual(normalizeProjectPath(" . "), ".");
  });
});

suite("parseProjects", () => {
  test("accepts a full entry", () => {
    const { entries, warnings } = parseProjects([
      {
        path: "apps/backend",
        classpathEnabled: true,
        classpathCommand: "clojure -A:dev:test -Spath",
      },
    ]);
    assert.deepStrictEqual(warnings, []);
    assert.deepStrictEqual(entries, [
      {
        path: "apps/backend",
        classpathEnabled: true,
        classpathCommand: "clojure -A:dev:test -Spath",
      },
    ]);
  });

  test("optional keys stay absent when omitted", () => {
    const { entries, warnings } = parseProjects([{ path: "libs/x" }]);
    assert.deepStrictEqual(warnings, []);
    assert.deepStrictEqual(entries, [{ path: "libs/x" }]);
  });

  test("normalizes the path", () => {
    const { entries } = parseProjects([{ path: "./apps/backend/" }, { path: "./" }]);
    assert.deepStrictEqual(
      entries.map((entry) => entry.path),
      ["apps/backend", "."],
    );
  });

  test("returns nothing for missing settings", () => {
    assert.deepStrictEqual(parseProjects(undefined), { entries: [], warnings: [] });
    assert.deepStrictEqual(parseProjects(null), { entries: [], warnings: [] });
  });

  test("warns on a non-array value", () => {
    const { entries, warnings } = parseProjects({ path: "." });
    assert.deepStrictEqual(entries, []);
    assert.strictEqual(warnings.length, 1);
  });

  test("skips non-object items with a warning, keeping the rest", () => {
    const { entries, warnings } = parseProjects(["oops", { path: "libs/x" }]);
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0].path, "libs/x");
    assert.strictEqual(warnings.length, 1);
  });

  test("skips entries without a usable path", () => {
    const { entries, warnings } = parseProjects([
      {},
      { path: "" },
      { path: "   " },
      { path: 7 },
    ]);
    assert.deepStrictEqual(entries, []);
    assert.strictEqual(warnings.length, 4);
  });

  test("skips entries with wrongly-typed optional keys", () => {
    const { entries, warnings } = parseProjects([
      { path: "a", classpathEnabled: "yes" },
      { path: "b", classpathCommand: 42 },
      { path: "c" },
    ]);
    assert.deepStrictEqual(
      entries.map((entry) => entry.path),
      ["c"],
    );
    assert.strictEqual(warnings.length, 2);
  });

  test("skips paths that escape the workspace", () => {
    const { entries, warnings } = parseProjects([
      { path: "/tmp/project" },
      { path: "../sibling" },
      { path: "apps/../.." },
      { path: "C:\\projects\\x" },
      { path: "apps/ok" },
    ]);
    assert.deepStrictEqual(
      entries.map((entry) => entry.path),
      ["apps/ok"],
    );
    assert.strictEqual(warnings.length, 4);
  });

  test("a backslash-spelled duplicate is detected", () => {
    const { entries, warnings } = parseProjects([
      { path: "apps/x" },
      { path: "apps\\x" },
    ]);
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(warnings.length, 1);
  });

  test("skips a duplicate path (after normalization) with a warning", () => {
    const { entries, warnings } = parseProjects([
      { path: "apps/x" },
      { path: "./apps/x/" },
    ]);
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(warnings.length, 1);
  });
});

suite("toServerConfig", () => {
  test("maps flat keys to the nested classpath shape", () => {
    assert.deepStrictEqual(
      toServerConfig([
        {
          path: "apps/backend",
          classpathEnabled: true,
          classpathCommand: "clojure -A:dev -Spath",
        },
      ]),
      {
        projects: [
          {
            path: "apps/backend",
            classpath: { enabled: true, cmd: "clojure -A:dev -Spath" },
          },
        ],
      },
    );
  });

  test("omits what the entry omits — the server owns defaults", () => {
    assert.deepStrictEqual(toServerConfig([{ path: "libs/x" }]), {
      projects: [{ path: "libs/x" }],
    });
    assert.deepStrictEqual(toServerConfig([{ path: ".", classpathEnabled: false }]), {
      projects: [{ path: ".", classpath: { enabled: false } }],
    });
    assert.deepStrictEqual(
      toServerConfig([{ path: ".", classpathCommand: "lein classpath" }]),
      { projects: [{ path: ".", classpath: { cmd: "lein classpath" } }] },
    );
  });

  test("maps an empty list to an empty projects array", () => {
    assert.deepStrictEqual(toServerConfig([]), { projects: [] });
  });
});

suite("withToggled", () => {
  test("updates the matching entry, preserving its other keys verbatim", () => {
    const raw = [
      { path: "./apps/backend/", classpathCommand: "clj -Spath", note: "keep me" },
      { path: "libs/x" },
    ];
    assert.deepStrictEqual(withToggled(raw, "apps/backend", true), [
      {
        path: "./apps/backend/",
        classpathCommand: "clj -Spath",
        note: "keep me",
        classpathEnabled: true,
      },
      { path: "libs/x" },
    ]);
  });

  test("inserts a minimal entry when no entry matches", () => {
    const raw = [{ path: "libs/x" }];
    assert.deepStrictEqual(withToggled(raw, "apps/backend", false), [
      { path: "libs/x" },
      { path: "apps/backend", classpathEnabled: false },
    ]);
  });

  test("inserts into an empty settings value", () => {
    assert.deepStrictEqual(withToggled([], ".", true), [
      { path: ".", classpathEnabled: true },
    ]);
  });

  test("preserves invalid entries verbatim and never matches them", () => {
    const raw = ["oops", { classpathEnabled: true }, 42];
    assert.deepStrictEqual(withToggled(raw, "apps/backend", true), [
      "oops",
      { classpathEnabled: true },
      42,
      { path: "apps/backend", classpathEnabled: true },
    ]);
  });

  test("a duplicate path updates only the first match", () => {
    const raw = [{ path: "apps/x" }, { path: "./apps/x" }];
    assert.deepStrictEqual(withToggled(raw, "apps/x", true), [
      { path: "apps/x", classpathEnabled: true },
      { path: "./apps/x" },
    ]);
  });

  test("stays explicit even when re-setting the same value", () => {
    const raw = [{ path: "apps/x", classpathEnabled: true }];
    assert.deepStrictEqual(withToggled(raw, "apps/x", true), [
      { path: "apps/x", classpathEnabled: true },
    ]);
  });

  test("insert then flip — the command's read-modify-write flow", () => {
    const inserted = withToggled([], "apps/backend", true);
    assert.deepStrictEqual(inserted, [{ path: "apps/backend", classpathEnabled: true }]);
    const flipped = withToggled(inserted, "./apps/backend", false);
    assert.deepStrictEqual(flipped, [{ path: "apps/backend", classpathEnabled: false }]);
    // The round-tripped entry still parses and maps.
    const { entries, warnings } = parseProjects(flipped);
    assert.deepStrictEqual(warnings, []);
    assert.deepStrictEqual(toServerConfig(entries), {
      projects: [{ path: "apps/backend", classpath: { enabled: false } }],
    });
  });

  test("does not mutate the input", () => {
    const raw = [{ path: "apps/x", classpathCommand: "clj -Spath" }];
    const copy = JSON.parse(JSON.stringify(raw));
    withToggled(raw, "apps/x", true);
    withToggled(raw, "new/one", false);
    assert.deepStrictEqual(raw, copy);
  });
});
