import * as assert from "assert";
import {
  CLOJUREDOCS_MIN_SERVER,
  ClojureDocsResult,
  buildClojureDocsMarkdown,
  describeClojureDocsFailure,
  noEntryMessage,
} from "../clojureDocs";

const full: ClojureDocsResult = {
  symbol: "clojure.core/map",
  entry: {
    ns: "clojure.core",
    name: "map",
    doc: "Returns a lazy sequence of results.",
    arglists: ["[f]", "[f coll]"],
    added: "1.0",
    examples: ['(map inc [1 2 3])\n;;=> (2 3 4)', '(map str ["x"])'],
    seeAlsos: ["clojure.core/mapv", "clojure.core/pmap"],
    url: "https://clojuredocs.org/clojure.core/map",
  },
};

const minimal: ClojureDocsResult = {
  symbol: "clojure.set/union",
  entry: {
    ns: "clojure.set",
    name: "union",
    arglists: [],
    examples: [],
    seeAlsos: [],
    url: "https://clojuredocs.org/clojure.set/union",
  },
};

suite("buildClojureDocsMarkdown", () => {
  test("names the var, the version, the page, and every example", () => {
    const md = buildClojureDocsMarkdown(full.entry!);
    assert.match(
      md,
      /^\*\*ClojureDocs: clojure\.core\/map\*\* · Available since 1\.0 · \[clojuredocs\.org\]\(https:\/\/clojuredocs\.org\/clojure\.core\/map\)$/m,
    );
    assert.match(md, /^\*\*Examples\*\*$/m);
    assert.strictEqual((md.match(/^```clojure$/gm) ?? []).length, 2);
    assert.ok(md.includes("```clojure\n(map inc [1 2 3])\n;;=> (2 3 4)\n```"));
    assert.ok(md.includes("```clojure\n(map str [\"x\"])\n```"));
  });

  test("links see-alsos as command URIs that re-run the command with the var", () => {
    const md = buildClojureDocsMarkdown(full.entry!);
    assert.match(md, /^\*\*See also\*\* /m);
    assert.ok(
      md.includes("[clojure.core/mapv](command:clojurePulse.showClojureDocs?%5B%22clojure.core%2Fmapv%22%5D)"),
      md,
    );
    assert.ok(md.includes("[clojure.core/pmap](command:clojurePulse.showClojureDocs?%5B%22clojure.core%2Fpmap%22%5D)"));
  });

  test("omits the version and see-alsos when absent and says when there are no examples", () => {
    const md = buildClojureDocsMarkdown(minimal.entry!);
    assert.match(md, /^\*\*ClojureDocs: clojure\.set\/union\*\* · \[clojuredocs\.org\]/m);
    assert.doesNotMatch(md, /Available since/);
    assert.doesNotMatch(md, /\*\*Examples\*\*/);
    assert.match(md, /^No examples on ClojureDocs yet\.$/m);
    assert.doesNotMatch(md, /See also/);
  });

  test("does not repeat the arglists or the docstring", () => {
    const md = buildClojureDocsMarkdown(full.entry!);
    assert.doesNotMatch(md, /\[f coll\]/);
    assert.doesNotMatch(md, /lazy sequence/);
  });

  test("widens the fence past any backticks inside an example", () => {
    const entry = { ...full.entry!, examples: ["(str \"```\")", "(str \"`\")"] };
    const md = buildClojureDocsMarkdown(entry);
    assert.ok(md.includes("````clojure\n(str \"```\")\n````"), md);
    assert.ok(md.includes("```clojure\n(str \"`\")\n```"), md);
  });

  test("escapes markdown in var names", () => {
    const entry = { ...minimal.entry!, ns: "clojure.core", name: "*", url: "https://clojuredocs.org/clojure.core/*" };
    const md = buildClojureDocsMarkdown(entry);
    assert.ok(md.includes("**ClojureDocs: clojure.core/\\***"), md);
    const star = { ...entry, seeAlsos: ["clojure.core/*'"] };
    assert.ok(buildClojureDocsMarkdown(star).includes("[clojure.core/\\*'](command:"), buildClojureDocsMarkdown(star));
  });
});

suite("describeClojureDocsFailure", () => {
  test("method not found names the minimum and the running server version", () => {
    const message = describeClojureDocsFailure(
      { code: -32601, message: "Method not found" },
      "0.3.0",
    );
    assert.match(message, /0\.4\.0/);
    assert.match(message, /0\.3\.0/);
    assert.strictEqual(CLOJUREDOCS_MIN_SERVER, "0.4.0");
  });

  test("method not found without a known version", () => {
    const message = describeClojureDocsFailure({ code: -32601, message: "x" }, undefined);
    assert.match(message, /0\.4\.0/);
    assert.doesNotMatch(message, /undefined/);
  });

  test("other response errors pass their message through", () => {
    const message = describeClojureDocsFailure(
      { code: -32603, message: "ClojureDocs data not configured" },
      "0.4.0",
    );
    assert.match(message, /ClojureDocs data not configured/);
  });

  test("plain errors pass their message through", () => {
    assert.match(describeClojureDocsFailure(new Error("boom"), "0.4.0"), /boom/);
  });
});

suite("noEntryMessage", () => {
  test("names the resolved symbol", () => {
    assert.match(noEntryMessage("clojure.core/frob"), /clojure\.core\/frob/);
  });

  test("explains an unresolved symbol", () => {
    assert.match(noEntryMessage(null), /symbol/i);
  });
});
