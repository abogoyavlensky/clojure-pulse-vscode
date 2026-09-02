#!/usr/bin/env node
// Build data/clojuredocs.json: the official ClojureDocs export stripped to what
// the clj-pulse server serves. The file keeps the export's own shape (so the
// server reads the raw download just as well) with fewer fields, sorted and
// written one var per line so a refresh diff shows exactly which vars changed.
//
// Dropped: notes (ClojureDocs licenses examples under CC0 but states no
// license for notes), contributor metadata, ids, timestamps, and `created-at`
// (it changes on every export and would defeat change detection).
//
//   node scripts/build-clojuredocs.mjs [source]
//
// `source` is a URL or a local file; default is the official export URL.
// Pure Node, no dependencies.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const EXPORT_URL = "https://clojuredocs.org/clojuredocs-export.json";
const OUT = "data/clojuredocs.json";
const DESCRIPTION = "ClojureDocs Data Export (stripped for Clojure Pulse)";

const str = (value) => (typeof value === "string" ? value : undefined);
const list = (value) => (Array.isArray(value) ? value : []);

/** One var in the kept shape, or null when it cannot be addressed. */
function stripVar(v) {
  if (!v || typeof v !== "object") {
    return null;
  }
  const ns = str(v.ns);
  const name = str(v.name);
  if (!ns || !name) {
    return null;
  }
  const out = { ns, name };
  const doc = str(v.doc);
  if (doc !== undefined) {
    out.doc = doc;
  }
  out.arglists = list(v.arglists).filter((a) => typeof a === "string");
  const added = str(v.added);
  if (added !== undefined) {
    out.added = added;
  }
  const href = str(v.href);
  if (href !== undefined) {
    out.href = href;
  }
  out.examples = list(v.examples)
    .map((e) => str(e?.body))
    .filter((body) => body !== undefined)
    .map((body) => ({ body }));
  out["see-alsos"] = list(v["see-alsos"])
    .map((s) => s?.["to-var"])
    .filter((t) => str(t?.ns) && str(t?.name))
    .map((t) => ({ "to-var": { ns: t.ns, name: t.name } }));
  return out;
}

const byNsThenName = (a, b) =>
  a.ns < b.ns ? -1 : a.ns > b.ns ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

/** The raw export object → the stripped, sorted export object. */
export function stripExport(raw) {
  const vars = list(raw?.vars).map(stripVar).filter(Boolean);
  vars.sort(byNsThenName);
  return { description: DESCRIPTION, vars };
}

/** JSON text with one var per line: `{"description":…,"vars":[\n…\n]}\n`. */
export function serialize(stripped) {
  const lines = stripped.vars.map((v) => JSON.stringify(v));
  return `{"description":${JSON.stringify(stripped.description)},"vars":[\n${lines.join(",\n")}\n]}\n`;
}

async function readSource(source) {
  if (/^https?:\/\//.test(source)) {
    const res = await fetch(source);
    if (!res.ok) {
      throw new Error(`${source}: HTTP ${res.status}`);
    }
    return res.text();
  }
  return readFileSync(source, "utf8");
}

async function main() {
  const source = process.argv[2] ?? EXPORT_URL;
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const stripped = stripExport(JSON.parse(await readSource(source)));
  mkdirSync(join(root, "data"), { recursive: true });
  writeFileSync(join(root, OUT), serialize(stripped));
  const examples = stripped.vars.reduce((n, v) => n + v.examples.length, 0);
  console.log(`${OUT}: ${stripped.vars.length} vars, ${examples} examples (from ${source})`);
}

// Run only as the entry point, so the test can import the pure functions.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e?.message ?? e);
    process.exit(1);
  });
}
