import * as assert from "assert";
import { matchLibrary, parseQuery } from "../externalLibrariesFilter";

const ENTRIES = ["META-INF/MANIFEST.MF", "aero/core.cljc", "aero/impl/walk.cljc"];

suite("externalLibrariesFilter", () => {
  test("parseQuery trims, lowercases, and splits on any whitespace", () => {
    assert.deepStrictEqual(parseQuery("  Aero \t CORE\n"), ["aero", "core"]);
    assert.deepStrictEqual(parseQuery(""), []);
    assert.deepStrictEqual(parseQuery("   "), []);
  });

  test("a label match shows the whole library regardless of entries", () => {
    assert.deepStrictEqual(matchLibrary(["aero"], "aero 1.1.6", ENTRIES), { whole: true });
    assert.deepStrictEqual(matchLibrary(["aero", "1.1"], "aero 1.1.6", []), { whole: true });
  });

  test("path, slash, and namespace forms all find the file", () => {
    for (const query of ["aero core", "aero/core", "aero.core", "AERO CORE"]) {
      assert.deepStrictEqual(
        matchLibrary(parseQuery(query), "aero 1.1.6", ENTRIES),
        { whole: false, entries: ["aero/core.cljc"] },
        query,
      );
    }
  });

  test("the namespace form maps underscores to dashes", () => {
    assert.deepStrictEqual(
      matchLibrary(["my-ns.core"], "lib 1.0", ["my_ns/core.clj", "other.clj"]),
      { whole: false, entries: ["my_ns/core.clj"] },
    );
  });

  test("terms may be split between the label and the path", () => {
    assert.deepStrictEqual(matchLibrary(["1.1.6", "walk"], "aero 1.1.6", ENTRIES), {
      whole: false,
      entries: ["aero/impl/walk.cljc"],
    });
  });

  test("no match is undefined", () => {
    assert.strictEqual(matchLibrary(["zzz"], "aero 1.1.6", ENTRIES), undefined);
  });

  test("an entries-only match keeps the input order", () => {
    assert.deepStrictEqual(
      matchLibrary(["cljc"], "aero 1.1.6", ["b/z.cljc", "a/y.cljc", "c.clj"]),
      { whole: false, entries: ["b/z.cljc", "a/y.cljc"] },
    );
  });
});
