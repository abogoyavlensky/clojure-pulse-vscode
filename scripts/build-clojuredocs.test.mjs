import { test } from "node:test";
import assert from "node:assert/strict";
import { serialize, stripExport } from "./build-clojuredocs.mjs";

/** A slice of the raw export: real field names, nulls, and extras. */
const raw = {
  "created-at": 1788243505643,
  description: "ClojureDocs Data Export",
  vars: [
    {
      ns: "clojure.string",
      name: "join",
      doc: "Joins.",
      arglists: ["coll", "separator coll"],
      notes: [{ body: "a note" }],
      examples: null,
      "see-alsos": null,
      _id: "1",
    },
    {
      ns: "clojure.core",
      name: "map",
      type: "function",
      doc: "Returns a lazy sequence.",
      added: "1.0",
      href: "/clojure.core/map",
      file: "clojure/core.clj",
      arglists: ["f", "f coll"],
      examples: [
        {
          body: "(map inc [1 2 3])",
          author: { login: "someone", "avatar-url": "https://example.invalid/a.png" },
          "created-at": 2,
          _id: "e1",
        },
        { _id: "no-body" },
      ],
      notes: [{ body: "must be dropped" }],
      "see-alsos": [
        { "to-var": { ns: "clojure.core", name: "mapv", "library-url": "l" }, _id: "s1" },
        { "to-var": null },
        { _id: "no-to-var" },
      ],
    },
    { name: "orphan", doc: "no ns" },
    { ns: "clojure.core", doc: "no name" },
    { ns: "clojure.core", name: "apply", doc: "Applies." },
  ],
};

test("keeps only the served fields, in the export's shape", () => {
  const { vars } = stripExport(raw);
  const map = vars.find((v) => v.name === "map");
  assert.deepEqual(Object.keys(map), ["ns", "name", "doc", "arglists", "added", "href", "examples", "see-alsos"]);
  assert.deepEqual(map.examples, [{ body: "(map inc [1 2 3])" }]);
  assert.deepEqual(map["see-alsos"], [{ "to-var": { ns: "clojure.core", name: "mapv" } }]);
  assert.equal(map.added, "1.0");
  assert.equal(map.href, "/clojure.core/map");
});

test("drops notes, timestamps, authors, and ids everywhere", () => {
  const text = serialize(stripExport(raw));
  for (const banned of ["notes", "created-at", "author", "avatar", "_id", "library-url", '"type"', '"file"']) {
    assert.ok(!text.includes(banned), `output must not contain ${banned}`);
  }
});

test("sorts vars by namespace then name and skips vars without both", () => {
  const { vars } = stripExport(raw);
  assert.deepEqual(
    vars.map((v) => `${v.ns}/${v.name}`),
    ["clojure.core/apply", "clojure.core/map", "clojure.string/join"],
  );
});

test("missing or null collections become empty arrays", () => {
  const { vars } = stripExport(raw);
  const join = vars.find((v) => v.name === "join");
  assert.deepEqual(join.examples, []);
  assert.deepEqual(join["see-alsos"], []);
  const apply = vars.find((v) => v.name === "apply");
  assert.deepEqual(apply.arglists, []);
  assert.equal("added" in apply, false);
  assert.equal("href" in apply, false);
});

test("tolerates an export without vars", () => {
  assert.deepEqual(stripExport({}).vars, []);
  assert.deepEqual(stripExport({ vars: null }).vars, []);
});

test("serialize writes one var per line and round-trips", () => {
  const stripped = stripExport(raw);
  const text = serialize(stripped);
  assert.deepEqual(JSON.parse(text), stripped);
  // Wrapper line, one line per var, closing line.
  assert.equal(text.trimEnd().split("\n").length, stripped.vars.length + 2);
  assert.ok(text.endsWith("\n"));
});
