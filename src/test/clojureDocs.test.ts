import * as assert from "assert";
import {
  CLOJUREDOCS_MIN_SERVER,
  ClojureDocsResult,
  describeClojureDocsFailure,
  noEntryMessage,
  renderClojureDocsHtml,
} from "../clojureDocs";

const full: ClojureDocsResult = {
  symbol: "clojure.core/map",
  entry: {
    ns: "clojure.core",
    name: "map",
    doc: "Returns a lazy sequence of <b>results</b>.",
    arglists: ["[f]", "[f coll]"],
    added: "1.0",
    examples: ['(map inc [1 2 3])\n;;=> (2 3 4)', '(map str ["<script>"])'],
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

suite("renderClojureDocsHtml", () => {
  test("renders every section of a full entry, escaped", () => {
    const html = renderClojureDocsHtml(full, "NONCE");
    assert.match(html, /clojure\.core\/map/);
    assert.match(html, /\[f\]/);
    assert.match(html, /\[f coll\]/);
    assert.match(html, /Available since 1\.0/);
    assert.match(html, /&lt;b&gt;results&lt;\/b&gt;/);
    assert.match(html, /&lt;script&gt;/);
    assert.doesNotMatch(html, /<script>/);
    assert.match(html, /<h2>Examples<\/h2>/);
    assert.strictEqual((html.match(/<pre class="example">/g) ?? []).length, 2);
    assert.match(html, /;;=&gt; \(2 3 4\)/);
    assert.match(html, /<h2>See also<\/h2>/);
    assert.match(html, /data-symbol="clojure\.core\/mapv"/);
    assert.match(html, /data-symbol="clojure\.core\/pmap"/);
    assert.match(html, /href="https:\/\/clojuredocs\.org\/clojure\.core\/map"/);
    assert.match(html, /CC0/);
    assert.match(html, /nonce-NONCE/);
    assert.match(html, /<script nonce="NONCE">/);
  });

  test("omits empty sections", () => {
    const html = renderClojureDocsHtml(minimal, "n");
    assert.match(html, /clojure\.set\/union/);
    assert.doesNotMatch(html, /Available since/);
    assert.doesNotMatch(html, /<h2>Examples<\/h2>/);
    assert.doesNotMatch(html, /<h2>See also<\/h2>/);
    assert.doesNotMatch(html, /<pre class="example">/);
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
