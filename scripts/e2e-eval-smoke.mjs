// End-to-end smoke test for the eval path against a real Babashka nREPL.
// Drives the compiled NreplClient + ConnectionManager + form selection exactly
// as the extension commands do, minus the GUI decoration rendering.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { NreplClient } = require("../out/nrepl/client.js");
const { ConnectionManager } = require("../out/repl/connectionManager.js");
const { Transcript } = require("../out/repl/transcript.js");
const { formAtCursor, nsBefore } = require("../out/repl/forms.js");

const results = [];
const check = (name, cond, detail = "") => {
  results.push({ name, ok: !!cond, detail });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

async function main() {
  const bb = process.env.BB || "bb";
  const server = spawn(bb, ["nrepl-server", "0"], { stdio: ["ignore", "pipe", "pipe"] });
  let port;
  const portRe = /nREPL server at [\d.]+:(\d+)/i;
  server.stdout.setEncoding("utf8");
  server.stderr.setEncoding("utf8");
  await new Promise((resolve, reject) => {
    const onData = (chunk) => {
      const m = chunk.match(portRe);
      if (m) {
        port = Number(m[1]);
        resolve();
      }
    };
    server.stdout.on("data", onData);
    server.stderr.on("data", onData);
    setTimeout(() => reject(new Error("nREPL did not start in time")), 15000);
  });
  console.log(`bb nREPL on port ${port}`);

  const transcript = new Transcript();
  const manager = new ConnectionManager(transcript);
  try {
    await manager.connect({ host: "127.0.0.1", port });
    check("connect", manager.state === "connected");

    // 1. Evaluate the innermost form at a cursor, in the buffer's namespace.
    const buffer = "(ns smoke.core)\n\n(defn add [a b] (+ a b))\n\n(add 20 22)";
    const cursor = buffer.length; // right after the final closing paren
    const range = formAtCursor(buffer, cursor);
    const code = buffer.slice(range.start, range.end);
    const ns = nsBefore(buffer, range.start);
    check("form at cursor is (add 20 22)", code === "(add 20 22)", code);
    check("ns detected", ns === "smoke.core", String(ns));
    // Load the defn first so the symbol exists, then eval the form.
    await manager.loadFile(buffer, { fileName: "core.clj" });
    const formOutcome = await manager.eval(code, { ns, line: 5, column: 1 });
    check("eval value is 42", formOutcome.value === "42", JSON.stringify(formOutcome));

    // 2. Evaluate File compiles the buffer as a unit (its ns form applies).
    const loadOutcome = await manager.loadFile(buffer, {
      fileName: "core.clj",
      filePath: "/tmp/smoke/core.clj",
    });
    check("load-file succeeds", loadOutcome.namespaceNotFound === false);
    const infoEntry = transcript.entries().find((e) => e.kind === "info" && e.text.includes("core.clj"));
    check("load-file logs an info entry", !!infoEntry);

    // 3. An exception surfaces as err, not value.
    const errOutcome = await manager.eval("(/ 1 0)");
    check("divide-by-zero yields err", !!errOutcome.err && errOutcome.value === undefined,
      JSON.stringify(errOutcome));

    // 4. Evaluating in a missing namespace flags namespace-not-found.
    const nsOutcome = await manager.eval(":x", { ns: "does.not.exist" });
    check("namespace-not-found flagged", nsOutcome.namespaceNotFound === true,
      JSON.stringify(nsOutcome));
  } finally {
    await manager.disconnect();
    server.kill("SIGKILL");
    await once(server, "exit").catch(() => {});
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
