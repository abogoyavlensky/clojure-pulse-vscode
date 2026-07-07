import * as assert from "assert";
import { encode } from "../nrepl/bencode";
import { NreplClient, NreplMessage } from "../nrepl/client";
import { startFakeNrepl, FakeNrepl } from "./fakeNreplServer";

suite("NreplClient", () => {
  let server: FakeNrepl;
  let client: NreplClient | undefined;

  setup(async () => {
    server = await startFakeNrepl();
  });

  teardown(async () => {
    client?.close();
    client = undefined;
    await server.close();
  });

  const connect = async (): Promise<NreplClient> => {
    client = await NreplClient.connect("127.0.0.1", server.port, 2000);
    return client;
  };

  test("connect resolves and clone returns a session id", async () => {
    const c = await connect();
    const session = await c.clone();
    assert.strictEqual(session, "sess-1");
  });

  test("describe returns the versions map", async () => {
    const c = await connect();
    const info = await c.describe();
    const versions = info.versions as {
      clojure: { "version-string": string };
    };
    assert.strictEqual(versions.clojure["version-string"], "1.12.0");
  });

  test("send correlates responses by id when they arrive interleaved", async () => {
    const held: Array<() => void> = [];
    server.respond((msg, reply) => {
      if (msg.op === "first") {
        // Delay the first response until the second has been sent.
        held.push(() => reply({ answer: "one", status: ["done"] }));
      } else {
        reply({ answer: "two", status: ["done"] });
        for (const release of held.splice(0)) {
          release();
        }
      }
    });
    const c = await connect();
    const [first, second] = await Promise.all([
      c.send({ op: "first" }),
      c.send({ op: "second" }),
    ]);
    assert.strictEqual(first[first.length - 1].answer, "one");
    assert.strictEqual(second[second.length - 1].answer, "two");
  });

  test("eval streams each partial message and resolves on done", async () => {
    server.respond((msg, reply) => {
      if (msg.op === "clone") {
        reply({ "new-session": "sess-1", status: ["done"] });
        return;
      }
      reply({ session: msg.session, out: "hi\n" });
      reply({ session: msg.session, value: "3" });
      reply({ session: msg.session, status: ["done"] });
    });
    const c = await connect();
    const session = await c.clone();
    const seen: string[] = [];
    const messages = await c.eval("(+ 1 2)", session, (m) => {
      if (m.out) {
        seen.push(`out:${m.out}`);
      }
      if (m.value) {
        seen.push(`value:${m.value}`);
      }
    });
    assert.deepStrictEqual(seen, ["out:hi\n", "value:3"]);
    assert.ok(messages.some((m) => m.value === "3"));
  });

  test("decodes a response split across TCP chunks", async () => {
    server.respond((msg, reply, socket) => {
      const full = encode({ id: msg.id, value: "λ-result", status: ["done"] });
      const mid = Math.floor(full.length / 2);
      socket.write(full.subarray(0, mid));
      setTimeout(() => socket.write(full.subarray(mid)), 20);
    });
    const c = await connect();
    const messages = await c.send({ op: "eval", code: "x" });
    assert.strictEqual(messages[0].value, "λ-result");
  });

  test("server socket close fires onClose and rejects pending requests", async () => {
    server.respond(() => {
      // Never reply; the request stays pending until the socket drops.
      setTimeout(() => server.dropConnections(), 20);
    });
    const c = await connect();
    let closed = false;
    c.onClose(() => {
      closed = true;
    });
    await assert.rejects(c.send({ op: "eval", code: "x" }));
    assert.strictEqual(closed, true);
  });

  test("connect rejects against a closed port", async () => {
    const deadPort = server.port;
    await server.close();
    await assert.rejects(NreplClient.connect("127.0.0.1", deadPort, 1000));
    server = await startFakeNrepl(); // teardown expects a live server
  });

  test("eval sends ns, file, line and column when provided", async () => {
    const c = await connect();
    const session = await c.clone();
    await c.eval("(+ 1 2)", session, undefined, {
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

  test("eval without extras puts none of their keys on the wire", async () => {
    const c = await connect();
    const session = await c.clone();
    await c.eval("(+ 1 2)", session);
    const msg = server.received.find((m) => m.op === "eval");
    assert.ok(msg);
    for (const key of ["ns", "file", "line", "column"]) {
      assert.ok(!(key in msg), `unexpected ${key} on the wire`);
    }
  });

  test("loadFile sends the load-file op with path params", async () => {
    const c = await connect();
    const session = await c.clone();
    await c.loadFile("(ns a)", session, undefined, {
      filePath: "/p/a.clj",
      fileName: "a.clj",
    });
    const msg = server.received.find((m) => m.op === "load-file");
    assert.ok(msg);
    assert.strictEqual(msg.file, "(ns a)");
    assert.strictEqual(msg["file-path"], "/p/a.clj");
    assert.strictEqual(msg["file-name"], "a.clj");
    assert.strictEqual(msg.session, session);
  });

  test("loadFile without extras omits the path params", async () => {
    const c = await connect();
    const session = await c.clone();
    await c.loadFile("(ns a)", session);
    const msg = server.received.find((m) => m.op === "load-file");
    assert.ok(msg);
    assert.ok(!("file-path" in msg));
    assert.ok(!("file-name" in msg));
  });

  test("messages without a pending id go to onUnhandled", async () => {
    server.respond((msg, reply, socket) => {
      socket.write(encode({ session: "sess-1", out: "background\n" }));
      reply({ status: ["done"] });
    });
    const c = await connect();
    const unhandled: NreplMessage[] = [];
    c.onUnhandled((m) => unhandled.push(m));
    await c.send({ op: "eval", code: "x" });
    assert.strictEqual(unhandled.length, 1);
    assert.strictEqual(unhandled[0].out, "background\n");
  });
});
