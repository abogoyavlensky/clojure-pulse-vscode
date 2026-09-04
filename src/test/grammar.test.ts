import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import * as oniguruma from "vscode-oniguruma";
import * as vsctm from "vscode-textmate";

/** Repo root: tests run from `out/test/`. */
const REPO_ROOT = path.join(__dirname, "..", "..");
const GRAMMAR_PATH = path.join(REPO_ROOT, "syntaxes", "clojure.tmLanguage.json");

let grammar: vsctm.IGrammar;

/** Scope stack of the token covering `column` on `line` of `source`. */
function scopesAt(source: string, line: number, column: number): string[] {
  const lines = source.split("\n");
  assert.ok(line < lines.length, `no line ${line} in ${JSON.stringify(source)}`);
  let stack = vsctm.INITIAL;
  for (let i = 0; i <= line; i++) {
    const result = grammar.tokenizeLine(lines[i], stack);
    stack = result.ruleStack;
    if (i < line) {
      continue;
    }
    const token = result.tokens.find(
      (t) => t.startIndex <= column && column < t.endIndex,
    );
    assert.ok(token, `no token at ${line}:${column} of ${JSON.stringify(source)}`);
    return token.scopes;
  }
  throw new Error("unreachable");
}

/** Scopes of the first `symbol` on `line` — how every case below reads a token. */
function scopesOf(source: string, line: number, symbol: string): string[] {
  const column = source.split("\n")[line].indexOf(symbol);
  assert.notStrictEqual(column, -1, `no ${symbol} on line ${line}`);
  return scopesAt(source, line, column);
}

const KEYWORD = "keyword.control.clojure";
const CONTROL = "storage.control.clojure";
const SYMBOL = "meta.symbol.clojure";

suite("clojure grammar", () => {
  suiteSetup(async () => {
    const wasm = fs.readFileSync(
      path.join(REPO_ROOT, "node_modules", "vscode-oniguruma", "release", "onig.wasm"),
    );
    await oniguruma.loadWASM(wasm);
    const registry = new vsctm.Registry({
      onigLib: Promise.resolve({
        createOnigScanner: (sources: string[]) => new oniguruma.OnigScanner(sources),
        createOnigString: (source: string) => new oniguruma.OnigString(source),
      }),
      loadGrammar: async () =>
        vsctm.parseRawGrammar(fs.readFileSync(GRAMMAR_PATH, "utf8"), GRAMMAR_PATH),
    });
    const loaded = await registry.loadGrammar("source.clojure");
    assert.ok(loaded, "source.clojure grammar failed to load");
    grammar = loaded;
  });

  test("a let binding named like a def form is a plain symbol", () => {
    const source = "(let [defenders 1]\n  defenders)";
    const binding = scopesOf(source, 0, "defenders");
    assert.ok(!binding.includes(KEYWORD), `binding scoped as ${binding.join(" ")}`);
    assert.ok(binding.includes(SYMBOL));
    const use = scopesOf(source, 1, "defenders");
    assert.ok(!use.includes(KEYWORD), `use scoped as ${use.join(" ")}`);
  });

  test("let bindings named like control forms are plain symbols", () => {
    const source = "(let [when-ready 1 cond 2])";
    const whenReady = scopesOf(source, 0, "when-ready");
    assert.ok(!whenReady.includes(CONTROL), `when-ready scoped as ${whenReady.join(" ")}`);
    assert.ok(whenReady.includes(SYMBOL));
    const cond = scopesOf(source, 0, "cond");
    assert.ok(!cond.includes(CONTROL), `cond scoped as ${cond.join(" ")}`);
    assert.ok(cond.includes(SYMBOL));
  });

  test("an argument named like a def form is a plain symbol", () => {
    const source = "(pick defenders team)";
    const argument = scopesOf(source, 0, "defenders");
    assert.ok(!argument.includes(KEYWORD), `argument scoped as ${argument.join(" ")}`);
    assert.ok(argument.includes(SYMBOL));
  });

  test("keywords quoted as data are plain symbols", () => {
    const quoted = scopesOf("'[if when]", 0, "if");
    assert.ok(!quoted.includes(CONTROL), `if scoped as ${quoted.join(" ")}`);
    assert.ok(quoted.includes(SYMBOL));
    const bracketed = scopesOf("[def]", 0, "def");
    assert.ok(!bracketed.includes(KEYWORD), `def scoped as ${bracketed.join(" ")}`);
    assert.ok(bracketed.includes(SYMBOL));
  });

  test("a defn keeps its keyword and its defined name", () => {
    const source = "(defn foo [x] x)";
    assert.ok(scopesOf(source, 0, "defn").includes(KEYWORD));
    assert.ok(scopesOf(source, 0, "foo").includes("entity.global.clojure"));
  });

  test("def and ns heads keep their keyword", () => {
    assert.ok(scopesOf("(def x 1)", 0, "def").includes(KEYWORD));
    assert.ok(scopesOf("(ns foo.bar)", 0, "ns").includes(KEYWORD));
  });

  test("control forms keep their keyword at the head of a form", () => {
    assert.ok(scopesOf("(when x 1)", 0, "when").includes(CONTROL));
    assert.ok(scopesOf("#(when % 1)", 0, "when").includes(CONTROL));
  });
});
