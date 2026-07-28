import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ConnectReplConfig, CreateReplConfig } from "../repl/replConfig";
import { ProcessExit, ReplProcessLike } from "../repl/replProcess";
import { ReplChannel, ReplSession, ReplSessionState } from "../repl/replSession";
import { FakeNrepl, startFakeNrepl } from "./fakeNreplServer";

/** Stands in for a VS Code output channel. */
function fakeChannel(): ReplChannel & { text: () => string; shown: () => number } {
  const parts: string[] = [];
  let shown = 0;
  return {
    append: (text: string) => parts.push(text),
    clear: () => (parts.length = 0),
    show: () => {
      shown += 1;
    },
    dispose: () => {},
    text: () => parts.join(""),
    shown: () => shown,
  };
}

/** A `ReplProcess` stand-in whose port resolution the test drives. */
class FakeProcess implements ReplProcessLike {
  started = false;
  stopCount = 0;
  private outputListeners: Array<(text: string) => void> = [];
  private exitListeners: Array<(exit: ProcessExit) => void> = [];
  private resolvePort!: (port: number) => void;
  private rejectPort!: (err: Error) => void;
  private readonly portPromise = new Promise<number>((resolve, reject) => {
    this.resolvePort = resolve;
    this.rejectPort = reject;
  });

  constructor() {
    this.portPromise.catch(() => {});
  }

  start(): void {
    this.started = true;
  }
  waitForPort(): Promise<number> {
    return this.portPromise;
  }
  onOutput(listener: (text: string) => void): void {
    this.outputListeners.push(listener);
  }
  onExit(listener: (exit: ProcessExit) => void): void {
    this.exitListeners.push(listener);
  }
  async stop(): Promise<void> {
    this.stopCount += 1;
  }

  emit(text: string): void {
    for (const listener of this.outputListeners) {
      listener(text);
    }
  }
  reportPort(port: number): void {
    this.resolvePort(port);
  }
  failPort(message: string): void {
    this.rejectPort(new Error(message));
    for (const listener of this.exitListeners) {
      listener({ code: 1, signal: null });
    }
  }
}

const createConfig = (over: Partial<CreateReplConfig> = {}): CreateReplConfig => ({
  name: "dev",
  type: "create",
  command: "clojure -M:nrepl",
  cwd: ".",
  ...over,
});

const connectConfig = (
  port: number | string,
  over: Partial<ConnectReplConfig> = {},
): ConnectReplConfig => ({
  name: "remote",
  type: "connect",
  host: "127.0.0.1",
  port,
  ...over,
});

suite("ReplSession", () => {
  let server: FakeNrepl;
  let channel: ReturnType<typeof fakeChannel>;
  let sessions: ReplSession[] = [];

  setup(async () => {
    server = await startFakeNrepl();
    channel = fakeChannel();
  });

  teardown(async () => {
    await Promise.all(sessions.map((session) => session.dispose()));
    sessions = [];
    await server.close();
  });

  const make = (
    config: CreateReplConfig | ConnectReplConfig,
    over: {
      process?: FakeProcess;
      workspaceRoot?: string;
    } = {},
  ) => {
    const session = new ReplSession(config, {
      workspaceRoot: over.workspaceRoot ?? process.cwd(),
      createChannel: () => channel,
      createProcess: () => over.process ?? new FakeProcess(),
    });
    sessions.push(session);
    return session;
  };

  test("connect config walks connecting → connected and banners the channel", async () => {
    const session = make(connectConfig(server.port));
    const states: ReplSessionState[] = [];
    session.onDidChangeState((state) => states.push(state));

    await session.start();

    assert.deepStrictEqual(states, ["connecting", "connected"]);
    assert.strictEqual(session.state, "connected");
    assert.deepStrictEqual(session.connectionInfo, {
      host: "127.0.0.1",
      port: server.port,
    });
    assert.ok(
      session.transcript.entries().some((e) => e.kind === "banner"),
      "expected a banner entry",
    );
    assert.ok(
      channel.text().includes(`;; Connected to nREPL at 127.0.0.1:${server.port}`),
      channel.text(),
    );
  });

  test("create config walks starting → connecting → connected", async () => {
    const proc = new FakeProcess();
    const session = make(createConfig(), { process: proc });
    const states: ReplSessionState[] = [];
    session.onDidChangeState((state) => states.push(state));

    const started = session.start();
    await waitUntil(() => session.state === "starting", 1000);
    assert.strictEqual(proc.started, true);
    proc.emit("nREPL server started\n");
    proc.reportPort(server.port);
    await started;

    assert.deepStrictEqual(states, ["starting", "connecting", "connected"]);
    assert.ok(channel.text().includes("nREPL server started"), channel.text());
  });

  test("process output lands in the transcript while starting", async () => {
    const proc = new FakeProcess();
    const session = make(createConfig(), { process: proc });
    void session.start().catch(() => {});
    await waitUntil(() => session.state === "starting", 1000);

    proc.emit("Downloading: nrepl/nrepl\n");

    assert.ok(
      session.transcript.entries().some((e) => e.text.includes("Downloading")),
      "expected process output in the transcript",
    );
  });

  test("a process that exits before reporting a port stops the session", async () => {
    const proc = new FakeProcess();
    const session = make(createConfig(), { process: proc });
    const started = session.start();
    await waitUntil(() => session.state === "starting", 1000);

    proc.failPort("nREPL process exited with code 1 before reporting a port");

    await assert.rejects(started, /exited with code 1/);
    assert.strictEqual(session.state, "stopped");
    assert.ok(
      channel.text().includes("exited with code 1"),
      channel.text(),
    );
  });

  test("stop() from connected disconnects and kills the process", async () => {
    const proc = new FakeProcess();
    const session = make(createConfig(), { process: proc });
    const started = session.start();
    await waitUntil(() => session.state === "starting", 1000);
    proc.reportPort(server.port);
    await started;

    await session.stop();

    assert.strictEqual(session.state, "stopped");
    assert.strictEqual(proc.stopCount, 1);
    assert.strictEqual(session.connectionInfo, undefined);
  });

  test("a connect failure after port discovery still kills the process", async () => {
    const dead = await startFakeNrepl();
    const deadPort = dead.port;
    await dead.close();
    const proc = new FakeProcess();
    const session = make(createConfig(), { process: proc });

    const started = session.start();
    await waitUntil(() => session.state === "starting", 1000);
    proc.reportPort(deadPort);

    await assert.rejects(started);
    assert.strictEqual(session.state, "stopped");
    assert.strictEqual(proc.stopCount, 1, "the spawned server must not outlive the session");
  });

  test("connection loss while connected kills the process", async () => {
    const proc = new FakeProcess();
    const session = make(createConfig(), { process: proc });
    const started = session.start();
    await waitUntil(() => session.state === "starting", 1000);
    proc.reportPort(server.port);
    await started;

    server.dropConnections();

    await waitUntil(() => session.state === "stopped", 2000);
    assert.strictEqual(session.state, "stopped");
    assert.strictEqual(proc.stopCount, 1);
  });

  test("a port-file config resolves the port from disk", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "repl-session-test-"));
    try {
      fs.writeFileSync(path.join(dir, ".nrepl-port"), `${server.port}\n`);
      const session = make(connectConfig(".nrepl-port"), { workspaceRoot: dir });

      await session.start();

      assert.strictEqual(session.state, "connected");
      assert.strictEqual(session.connectionInfo?.port, server.port);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a missing port file fails with the path it looked at", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "repl-session-test-"));
    try {
      const session = make(connectConfig(".nrepl-port"), { workspaceRoot: dir });

      await assert.rejects(session.start(), (err: Error) =>
        err.message.includes(path.join(dir, ".nrepl-port")),
      );
      assert.strictEqual(session.state, "stopped");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("eval routes through the session's connection", async () => {
    const session = make(connectConfig(server.port));
    await session.start();

    const outcome = await session.eval("(+ 1 2)");

    assert.strictEqual(outcome.value, "42");
    assert.ok(channel.text().includes("=> 42"), channel.text());
  });

  test("eval before starting rejects", async () => {
    const session = make(connectConfig(server.port));
    await assert.rejects(session.eval("(+ 1 2)"), /not connected/i);
  });

  test("start() on a connected session is a no-op", async () => {
    const session = make(connectConfig(server.port));
    await session.start();
    const states: ReplSessionState[] = [];
    session.onDidChangeState((state) => states.push(state));

    await session.start();

    assert.deepStrictEqual(states, []);
    assert.strictEqual(session.state, "connected");
  });

  test("showOutput reveals the channel, creating it when never started", () => {
    const session = make(connectConfig(server.port));
    session.showOutput();
    assert.strictEqual(channel.shown(), 1);
  });
});

async function waitUntil(
  condition: () => boolean,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
