import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { reformatString } from "@abogoyavlensky/cljfmt-js";
import { createConfigDiscovery } from "../fmt/configDiscovery";
import { createNsContextCache } from "../fmt/nsContext";

/** Distinguishes community vs cursive configs by observable behavior. */
function styleOf(config: unknown): "community" | "cursive" {
  const out = reformatString("(foo\nbar)", config as never);
  return out === "(foo\n bar)" ? "community" : "cursive";
}

const CURSIVE = "{:function-arguments-indentation :cursive}";

function tempTree(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cljp-cfg-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return root;
}

suite("configDiscovery", () => {
  test("nearest config wins over an ancestor's", () => {
    const root = tempTree({
      ".cljfmt.edn": CURSIVE,
      "sub/.cljfmt.edn": "{}",
    });
    const d = createConfigDiscovery();
    const found = d.configFor(path.join(root, "sub", "x.clj"), root);
    assert.strictEqual(found.path, path.join(root, "sub", ".cljfmt.edn"));
    assert.strictEqual(styleOf(found.config), "community");
    const parent = d.configFor(path.join(root, "x.clj"), root);
    assert.strictEqual(styleOf(parent.config), "cursive");
  });

  test(".cljfmt.edn beats cljfmt.edn in the same directory", () => {
    const root = tempTree({
      ".cljfmt.edn": CURSIVE,
      "cljfmt.edn": "{}",
    });
    const found = createConfigDiscovery().configFor(path.join(root, "x.clj"), root);
    assert.strictEqual(found.path, path.join(root, ".cljfmt.edn"));
    assert.strictEqual(styleOf(found.config), "cursive");
  });

  test("no config yields defaults and maxInner 2", () => {
    const root = tempTree({});
    const found = createConfigDiscovery().configFor(path.join(root, "x.clj"), root);
    assert.strictEqual(found.path, undefined);
    assert.strictEqual(found.error, undefined);
    assert.strictEqual(found.maxInner, 2);
    assert.strictEqual(styleOf(found.config), "community");
  });

  test("a config above the stop directory is not found", () => {
    const root = tempTree({ ".cljfmt.edn": CURSIVE });
    const ws = path.join(root, "ws");
    fs.mkdirSync(path.join(ws, "sub"), { recursive: true });
    const found = createConfigDiscovery().configFor(path.join(ws, "sub", "x.clj"), ws);
    assert.strictEqual(found.path, undefined);
  });

  test("without a stop directory only the file's own dir is searched", () => {
    const root = tempTree({ ".cljfmt.edn": CURSIVE, "sub/keep": "" });
    const d = createConfigDiscovery();
    assert.strictEqual(d.configFor(path.join(root, "sub", "x.clj"), null).path, undefined);
    assert.strictEqual(
      d.configFor(path.join(root, "x.clj"), null).path,
      path.join(root, ".cljfmt.edn"),
    );
  });

  test("parse errors report the path and fall back to defaults", () => {
    const root = tempTree({ ".cljfmt.edn": "{oops" });
    const found = createConfigDiscovery().configFor(path.join(root, "x.clj"), root);
    assert.strictEqual(found.path, path.join(root, ".cljfmt.edn"));
    assert.ok(found.error && found.error.length > 0);
    assert.strictEqual(found.maxInner, 2);
    assert.strictEqual(styleOf(found.config), "community");
  });

  test("maxInner comes from :inner depths in the raw EDN", () => {
    const cases: [string, number][] = [
      ["{:extra-indents {foo [[:inner 3]]}}", 3],
      ["{:extra-indents {foo [[:inner 2 0]]}}", 2],
      ["{:extra-indents {foo [[:block 5]]}}", 2],
      ["{:extra-indents {foo [[:inner 1]] bar [[:inner 4]]}}", 4],
    ];
    for (const [edn, expected] of cases) {
      const root = tempTree({ ".cljfmt.edn": edn });
      const found = createConfigDiscovery().configFor(path.join(root, "x.clj"), root);
      assert.strictEqual(found.maxInner, expected, edn);
    }
  });

  test("lookups are cached until invalidated", () => {
    const root = tempTree({ ".cljfmt.edn": CURSIVE });
    let reads = 0;
    const d = createConfigDiscovery((p) => {
      reads++;
      try {
        return fs.readFileSync(p, "utf8");
      } catch {
        return null;
      }
    });
    const file = path.join(root, "x.clj");
    d.configFor(file, root);
    const before = reads;
    d.configFor(file, root);
    assert.strictEqual(reads, before);
    fs.writeFileSync(path.join(root, ".cljfmt.edn"), "{}");
    d.invalidate();
    const after = d.configFor(file, root);
    assert.ok(reads > before);
    assert.strictEqual(styleOf(after.config), "community");
  });
});

suite("nsContextCache", () => {
  test("derives once per version and drops on demand", () => {
    const cache = createNsContextCache();
    let derived = 0;
    const text = () => {
      derived++;
      return "(ns app (:require [my.lib :as ml]))";
    };
    const a = cache.contextFor("file:///x.clj", 1, text);
    const b = cache.contextFor("file:///x.clj", 1, text);
    assert.strictEqual(derived, 1);
    assert.strictEqual(a, b);
    cache.contextFor("file:///x.clj", 2, text);
    assert.strictEqual(derived, 2);
    cache.drop("file:///x.clj");
    cache.contextFor("file:///x.clj", 2, text);
    assert.strictEqual(derived, 3);
  });
});
