import * as assert from "assert";
import {
  ConnectCancelledError,
  ConnectionManager,
  ReplState,
} from "../repl/connectionManager";
import { Transcript } from "../repl/transcript";
import { startFakeNrepl, FakeNrepl } from "./fakeNreplServer";

async function waitUntil(
  condition: () => boolean,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

suite("ConnectionManager", () => {
  let server: FakeNrepl;
  let manager: ConnectionManager;
  let transcript: Transcript;

  setup(async () => {
    server = await startFakeNrepl();
    transcript = new Transcript();
    manager = new ConnectionManager(transcript);
  });

  teardown(async () => {
    await manager.disconnect();
    await server.close();
  });

  const texts = () => transcript.entries().map((e) => `${e.kind}|${e.text}`);

  test("connect walks disconnected → connecting → connected and prints a banner", async () => {
    const states: ReplState[] = [];
    manager.onDidChangeState((state) => states.push(state));
    assert.strictEqual(manager.state, "disconnected");

    await manager.connect({ host: "127.0.0.1", port: server.port });

    assert.deepStrictEqual(states, ["connecting", "connected"]);
    assert.strictEqual(manager.state, "connected");
    const banner = transcript.entries().find((e) => e.kind === "banner");
    assert.ok(banner, "expected a banner entry");
    assert.ok(banner.text.includes(`127.0.0.1:${server.port}`));
    assert.ok(banner.text.includes("nREPL 1.1.0"));
    assert.ok(banner.text.includes("Clojure 1.12.0"));
  });

  test("connect to a closed port rejects and returns to disconnected", async () => {
    const deadServer = await startFakeNrepl();
    const deadPort = deadServer.port;
    await deadServer.close();

    await assert.rejects(manager.connect({ host: "127.0.0.1", port: deadPort }));
    assert.strictEqual(manager.state, "disconnected");
  });

  test("disconnect closes the connection and appends an info entry", async () => {
    await manager.connect({ host: "127.0.0.1", port: server.port });
    await manager.disconnect();

    assert.strictEqual(manager.state, "disconnected");
    assert.ok(
      transcript
        .entries()
        .some((e) => e.kind === "info" && /disconnected/i.test(e.text)),
      `expected a disconnect info entry, got: ${texts().join(", ")}`,
    );
  });

  test("server-side socket drop flips to disconnected with an info entry", async () => {
    await manager.connect({ host: "127.0.0.1", port: server.port });
    const stateChange = new Promise<ReplState>((resolve) =>
      manager.onDidChangeState((state) => resolve(state)),
    );

    server.dropConnections();

    assert.strictEqual(await stateChange, "disconnected");
    assert.ok(
      transcript
        .entries()
        .some((e) => e.kind === "info" && /lost/i.test(e.text)),
      `expected a connection-lost info entry, got: ${texts().join(", ")}`,
    );
  });

  test("eval appends in, then value entries", async () => {
    await manager.connect({ host: "127.0.0.1", port: server.port });
    await manager.eval("(+ 1 2)");

    const kinds = transcript.entries().map((e) => e.kind);
    const inIndex = kinds.indexOf("in");
    const valueIndex = kinds.indexOf("value");
    assert.ok(inIndex !== -1, "expected an in entry");
    assert.ok(valueIndex > inIndex, "expected value after in");
    assert.strictEqual(
      transcript.entries()[inIndex].text,
      "(+ 1 2)",
    );
    assert.strictEqual(transcript.entries()[valueIndex].text, "42");
  });

  test("a quiet eval leaves the transcript alone but still resolves", async () => {
    server.respond((msg, reply) => {
      if (msg.op === "clone") {
        reply({ "new-session": "sess-1", status: ["done"] });
        return;
      }
      if (msg.op === "describe") {
        reply({ versions: {}, status: ["done"] });
        return;
      }
      reply({ session: msg.session, out: "loading\n" });
      reply({ session: msg.session, value: "nil" });
      reply({ session: msg.session, status: ["done"] });
    });
    await manager.connect({ host: "127.0.0.1", port: server.port });
    const before = transcript.entries().length;
    const outcome = await manager.eval("(require 'clj-reload.core)", {
      quiet: true,
    });

    assert.strictEqual(outcome.value, "nil", "the caller still sees the result");
    assert.strictEqual(outcome.out, "loading\n");
    assert.strictEqual(
      transcript.entries().length,
      before,
      texts().slice(before).join(", "),
    );
  });

  test("eval streams out and err entries", async () => {
    server.respond((msg, reply) => {
      if (msg.op === "clone") {
        reply({ "new-session": "sess-1", status: ["done"] });
        return;
      }
      if (msg.op === "describe") {
        reply({ versions: {}, status: ["done"] });
        return;
      }
      reply({ session: msg.session, out: "printed\n" });
      reply({ session: msg.session, err: "warned\n" });
      reply({ session: msg.session, value: "nil" });
      reply({ session: msg.session, status: ["done"] });
    });
    await manager.connect({ host: "127.0.0.1", port: server.port });
    await manager.eval("(println :x)");

    const entries = texts();
    assert.ok(entries.includes("out|printed\n"), entries.join(", "));
    assert.ok(entries.includes("err|warned\n"), entries.join(", "));
    assert.ok(entries.includes("value|nil"), entries.join(", "));
  });

  test("eval accumulates out chunks into the outcome", async () => {
    server.respond((msg, reply) => {
      if (msg.op === "clone") {
        reply({ "new-session": "sess-1", status: ["done"] });
        return;
      }
      if (msg.op === "describe") {
        reply({ versions: {}, status: ["done"] });
        return;
      }
      reply({ session: msg.session, out: "FAIL in (my-test)\n" });
      reply({ session: msg.session, out: "expected: (= 1 2)\n" });
      reply({ session: msg.session, value: "nil" });
      reply({ session: msg.session, status: ["done"] });
    });
    await manager.connect({ host: "127.0.0.1", port: server.port });
    const outcome = await manager.eval("(run)");

    assert.strictEqual(outcome.out, "FAIL in (my-test)\nexpected: (= 1 2)\n");
  });

  test("eval with no out messages leaves outcome.out undefined", async () => {
    await manager.connect({ host: "127.0.0.1", port: server.port });
    const outcome = await manager.eval("(+ 1 2)");

    assert.strictEqual(outcome.out, undefined);
  });

  test("ANSI escape codes in out and err are stripped", async () => {
    server.respond((msg, reply) => {
      if (msg.op === "clone") {
        reply({ "new-session": "sess-1", status: ["done"] });
        return;
      }
      if (msg.op === "describe") {
        reply({ versions: {}, status: ["done"] });
        return;
      }
      reply({ session: msg.session, out: "\x1b[38;5;45mmalli:\x1b[0m dev-mode\n" });
      // A sequence split across two messages proves the out stripper is one
      // per-connection instance, not created per message.
      reply({ session: msg.session, out: "a\x1b[3" });
      reply({ session: msg.session, out: "8;5;45mb\n" });
      reply({ session: msg.session, err: "\x1b[31mboom\x1b[0m\n" });
      reply({ session: msg.session, status: ["done"] });
    });
    await manager.connect({ host: "127.0.0.1", port: server.port });
    const outcome = await manager.eval("(start)");

    const entries = texts();
    assert.ok(entries.includes("out|malli: dev-mode\n"), entries.join(", "));
    assert.ok(entries.includes("out|a"), entries.join(", "));
    assert.ok(entries.includes("out|b\n"), entries.join(", "));
    assert.ok(entries.includes("err|boom\n"), entries.join(", "));
    assert.strictEqual(outcome.err, "boom\n");
  });

  test("eval resolves with the value outcome", async () => {
    await manager.connect({ host: "127.0.0.1", port: server.port });
    const outcome = await manager.eval("(+ 1 2)");
    assert.deepStrictEqual(outcome, { value: "42", namespaceNotFound: false });
  });

  test("eval resolves with concatenated err and no value on an eval error", async () => {
    server.respond((msg, reply) => {
      if (msg.op === "clone") {
        reply({ "new-session": "sess-1", status: ["done"] });
        return;
      }
      if (msg.op === "describe") {
        reply({ versions: {}, status: ["done"] });
        return;
      }
      reply({ session: msg.session, err: "Syntax error " });
      reply({ session: msg.session, err: "compiling\n" });
      reply({ session: msg.session, status: ["eval-error", "done"] });
    });
    await manager.connect({ host: "127.0.0.1", port: server.port });
    const outcome = await manager.eval("(foo");
    assert.strictEqual(outcome.value, undefined);
    assert.strictEqual(outcome.err, "Syntax error compiling\n");
    assert.strictEqual(outcome.namespaceNotFound, false);
  });

  test("eval flags namespace-not-found", async () => {
    server.respond((msg, reply) => {
      if (msg.op === "clone") {
        reply({ "new-session": "sess-1", status: ["done"] });
        return;
      }
      if (msg.op === "describe") {
        reply({ versions: {}, status: ["done"] });
        return;
      }
      reply({ session: msg.session, status: ["namespace-not-found", "done"] });
    });
    await manager.connect({ host: "127.0.0.1", port: server.port });
    const outcome = await manager.eval("(+ 1 2)", { ns: "missing.ns" });
    assert.strictEqual(outcome.namespaceNotFound, true);
  });

  test("eval passes ns, file, line and column through to the server", async () => {
    await manager.connect({ host: "127.0.0.1", port: server.port });
    await manager.eval("(+ 1 2)", {
      ns: "foo.bar",
      file: "/p/a.clj",
      line: 3,
      column: 1,
    });
    const msg = server.received.find((m) => m.op === "eval");
    assert.ok(msg);
    assert.strictEqual(msg.ns, "foo.bar");
    assert.strictEqual(msg.file, "/p/a.clj");
    assert.strictEqual(msg.line, 3);
    assert.strictEqual(msg.column, 1);
  });

  test("loadFile appends an info entry, streams value, and resolves", async () => {
    await manager.connect({ host: "127.0.0.1", port: server.port });
    const outcome = await manager.loadFile("(ns a) :done", {
      fileName: "a.clj",
      filePath: "/p/a.clj",
    });

    const entries = transcript.entries();
    const info = entries.find((e) => e.kind === "info" && e.text.includes("a.clj"));
    assert.ok(info, `expected a load info entry, got: ${texts().join(", ")}`);
    // The whole file text is not echoed as an `in` entry.
    assert.ok(!entries.some((e) => e.kind === "in" && e.text.includes("(ns a)")));
    assert.ok(entries.some((e) => e.kind === "value" && e.text === "42"));
    assert.strictEqual(outcome.value, "42");

    const msg = server.received.find((m) => m.op === "load-file");
    assert.ok(msg);
    assert.strictEqual(msg.file, "(ns a) :done");
    assert.strictEqual(msg["file-path"], "/p/a.clj");
    assert.strictEqual(msg["file-name"], "a.clj");
  });

  test("connect times out when the server accepts TCP but never answers", async () => {
    server.respond(() => {
      // Swallow every message — a non-nREPL service holding the port.
    });
    const fast = new ConnectionManager(transcript, { connectTimeoutMs: 100 });
    await assert.rejects(
      fast.connect({ host: "127.0.0.1", port: server.port }),
      /timed out/i,
    );
    assert.strictEqual(fast.state, "disconnected");
  });

  test("closes the socket when the handshake fails", async () => {
    server.respond((msg, reply) => {
      // clone answers "done" but without a session id: an invalid handshake.
      reply({ status: ["done"] });
    });
    await assert.rejects(
      manager.connect({ host: "127.0.0.1", port: server.port }),
      /session/i,
    );
    assert.strictEqual(manager.state, "disconnected");
    await waitUntil(() => server.socketCount() === 0, 1000);
    assert.strictEqual(server.socketCount(), 0);
  });

  test("disconnect during connecting cancels the in-flight attempt", async () => {
    server.respond((msg, reply) => {
      if (msg.op === "clone") {
        // Hold the handshake open long enough to disconnect mid-attempt.
        setTimeout(
          () => reply({ "new-session": "sess-1", status: ["done"] }),
          150,
        );
        return;
      }
      reply({ versions: {}, status: ["done"] });
    });
    const pending = manager.connect({ host: "127.0.0.1", port: server.port });
    await waitUntil(() => manager.state === "connecting", 1000);
    await manager.disconnect();

    await assert.rejects(pending, ConnectCancelledError);
    assert.strictEqual(manager.state, "disconnected");
    await waitUntil(() => server.socketCount() === 0, 1000);
    assert.strictEqual(server.socketCount(), 0);
  });

  test("cancelling an unresponsive handshake reports cancellation, not the timeout", async () => {
    server.respond(() => {
      // Never answer — the handshake can only end by timing out.
    });
    const fast = new ConnectionManager(transcript, { connectTimeoutMs: 200 });
    const pending = fast.connect({ host: "127.0.0.1", port: server.port });
    await waitUntil(() => fast.state === "connecting", 1000);
    await fast.disconnect();

    await assert.rejects(pending, ConnectCancelledError);
    assert.strictEqual(fast.state, "disconnected");
  });

  test("eval without a connection rejects", async () => {
    await assert.rejects(manager.eval("(+ 1 2)"), /not connected/i);
  });
});
