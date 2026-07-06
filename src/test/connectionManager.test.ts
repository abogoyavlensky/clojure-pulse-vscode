import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  ConnectCancelledError,
  ConnectionManager,
  ReplState,
  readNreplPort,
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

suite("readNreplPort", () => {
  test("returns the port from a .nrepl-port file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nrepl-port-test-"));
    try {
      fs.writeFileSync(path.join(dir, ".nrepl-port"), "7888\n");
      assert.strictEqual(readNreplPort(dir), 7888);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("returns undefined when the file is absent or invalid", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nrepl-port-test-"));
    try {
      assert.strictEqual(readNreplPort(dir), undefined);
      fs.writeFileSync(path.join(dir, ".nrepl-port"), "not-a-port");
      assert.strictEqual(readNreplPort(dir), undefined);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
