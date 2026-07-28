import * as assert from "assert";
import { EvalOutcome, ReplConnectionInfo } from "../repl/connectionManager";
import { ConnectReplConfig, CreateReplConfig, ReplConfig } from "../repl/replConfig";
import { ReplRegistry } from "../repl/replRegistry";
import { ReplChannel, ReplSessionLike, ReplSessionState } from "../repl/replSession";

function fakeChannel(name: string): ReplChannel & { name: string; disposed: boolean } {
  return {
    name,
    disposed: false,
    append: () => {},
    clear: () => {},
    show: () => {},
    dispose() {
      this.disposed = true;
    },
  };
}

class FakeSession implements ReplSessionLike {
  state: ReplSessionState = "stopped";
  startCount = 0;
  stopCount = 0;
  disposed = false;
  readonly channel: ReplChannel;
  private listeners: Array<(state: ReplSessionState) => void> = [];

  constructor(
    readonly config: ReplConfig,
    channelFor: (name: string) => ReplChannel,
  ) {
    this.channel = channelFor(config.name);
  }

  get name(): string {
    return this.config.name;
  }
  get connectionInfo(): ReplConnectionInfo | undefined {
    return this.state === "connected" ? { host: "localhost", port: 1234 } : undefined;
  }
  async start(): Promise<void> {
    this.startCount += 1;
    this.moveTo("connected");
  }
  async stop(): Promise<void> {
    this.stopCount += 1;
    this.moveTo("stopped");
  }
  async eval(): Promise<EvalOutcome> {
    return { namespaceNotFound: false };
  }
  async loadFile(): Promise<EvalOutcome> {
    return { namespaceNotFound: false };
  }
  showOutput(): void {}
  onDidChangeState(listener: (state: ReplSessionState) => void): void {
    this.listeners.push(listener);
  }
  async dispose(): Promise<void> {
    this.disposed = true;
  }

  /** Drives a state transition the way a real session would. */
  moveTo(state: ReplSessionState): void {
    if (this.state === state) {
      return;
    }
    this.state = state;
    for (const listener of this.listeners) {
      listener(state);
    }
  }
}

const connectConfig = (
  name: string,
  port: number | string = 7888,
): ConnectReplConfig => ({ name, type: "connect", host: "localhost", port });

const createConfig = (name: string, command = "clj -M:nrepl"): CreateReplConfig => ({
  name,
  type: "create",
  command,
  cwd: ".",
});

suite("ReplRegistry", () => {
  let channels: Array<ReturnType<typeof fakeChannel>>;
  let created: FakeSession[];
  let registry: ReplRegistry;

  setup(() => {
    channels = [];
    created = [];
    registry = new ReplRegistry({
      createChannel: (name) => {
        const channel = fakeChannel(name);
        channels.push(channel);
        return channel;
      },
      createSession: (config, channelFor) => {
        const session = new FakeSession(config, channelFor);
        created.push(session);
        return session;
      },
    });
  });

  teardown(async () => {
    await registry.dispose();
  });

  const sessionNamed = (name: string) => registry.get(name) as FakeSession | undefined;

  test("creates one session per configuration, in order", () => {
    registry.setConfigs([connectConfig("a"), createConfig("b")]);

    assert.deepStrictEqual(
      registry.sessions.map((s) => s.name),
      ["a", "b"],
    );
  });

  test("re-applying identical configurations keeps the same sessions", () => {
    registry.setConfigs([connectConfig("a")]);
    const first = sessionNamed("a");

    registry.setConfigs([connectConfig("a")]);

    assert.strictEqual(sessionNamed("a"), first);
    assert.strictEqual(created.length, 1);
  });

  test("removing a configuration stops the session and disposes its channel", async () => {
    registry.setConfigs([connectConfig("a"), connectConfig("b")]);
    const removed = sessionNamed("a");
    const channel = channels.find((c) => c.name === "a");

    await registry.setConfigs([connectConfig("b")]);

    assert.deepStrictEqual(
      registry.sessions.map((s) => s.name),
      ["b"],
    );
    assert.strictEqual(removed?.disposed, true);
    assert.strictEqual(channel?.disposed, true);
  });

  test("editing a stopped session's configuration applies immediately", () => {
    registry.setConfigs([createConfig("a", "clj -M:nrepl")]);
    const before = sessionNamed("a");

    registry.setConfigs([createConfig("a", "clj -M:dev:nrepl")]);

    const after = sessionNamed("a");
    assert.notStrictEqual(after, before);
    assert.strictEqual(
      after?.config.type === "create" ? after.config.command : undefined,
      "clj -M:dev:nrepl",
    );
    assert.strictEqual(before?.disposed, true);
  });

  test("a replaced session keeps its channel, so history survives", () => {
    registry.setConfigs([createConfig("a", "clj -M:nrepl")]);
    const first = sessionNamed("a");

    registry.setConfigs([createConfig("a", "clj -M:dev:nrepl")]);

    assert.strictEqual(sessionNamed("a")?.channel, first?.channel);
    assert.strictEqual(channels.filter((c) => c.name === "a").length, 1);
  });

  test("editing a running session defers until it stops", async () => {
    registry.setConfigs([createConfig("a", "clj -M:nrepl")]);
    const running = sessionNamed("a");
    await running?.start();

    registry.setConfigs([createConfig("a", "clj -M:dev:nrepl")]);

    assert.strictEqual(sessionNamed("a"), running, "must keep the launched config");
    assert.strictEqual(
      sessionNamed("a")?.config.type === "create"
        ? (sessionNamed("a")?.config as CreateReplConfig).command
        : undefined,
      "clj -M:nrepl",
    );

    running?.moveTo("stopped");

    const replaced = sessionNamed("a");
    assert.notStrictEqual(replaced, running);
    assert.strictEqual((replaced?.config as CreateReplConfig).command, "clj -M:dev:nrepl");
    assert.strictEqual(replaced?.channel, running?.channel);
  });

  test("a session that connects becomes active", async () => {
    registry.setConfigs([connectConfig("a"), connectConfig("b")]);
    assert.strictEqual(registry.active?.name, undefined);

    await sessionNamed("a")?.start();
    assert.strictEqual(registry.active?.name, "a");

    await sessionNamed("b")?.start();
    assert.strictEqual(registry.active?.name, "b");
  });

  test("active is cleared when the active session stops", async () => {
    registry.setConfigs([connectConfig("a")]);
    await sessionNamed("a")?.start();

    await sessionNamed("a")?.stop();

    assert.strictEqual(registry.active, undefined);
  });

  test("setActive switches the eval target", async () => {
    registry.setConfigs([connectConfig("a"), connectConfig("b")]);
    await sessionNamed("a")?.start();
    await sessionNamed("b")?.start();

    registry.setActive("a");

    assert.strictEqual(registry.active?.name, "a");
  });

  test("setActive ignores an unknown name", () => {
    registry.setConfigs([connectConfig("a")]);
    registry.setActive("nope");
    assert.strictEqual(registry.active, undefined);
  });

  test("ad-hoc sessions are named host:port and vanish when they stop", async () => {
    const session = registry.addAdHoc({ host: "127.0.0.1", port: 7890 }) as FakeSession;
    assert.strictEqual(session.name, "127.0.0.1:7890");
    assert.strictEqual(registry.sessions.length, 1);

    await session.start();
    assert.strictEqual(registry.active?.name, "127.0.0.1:7890");

    await session.stop();

    assert.deepStrictEqual(registry.sessions, []);
    assert.strictEqual(session.disposed, true);
    assert.strictEqual(registry.active, undefined);
  });

  test("configuration changes leave ad-hoc sessions alone", async () => {
    const adHoc = registry.addAdHoc({ host: "127.0.0.1", port: 7890 }) as FakeSession;
    await adHoc.start();

    registry.setConfigs([connectConfig("a")]);

    assert.deepStrictEqual(
      registry.sessions.map((s) => s.name).sort(),
      ["127.0.0.1:7890", "a"],
    );
  });

  test("onDidChange fires for session state changes and configuration edits", async () => {
    let changes = 0;
    registry.onDidChange(() => (changes += 1));

    registry.setConfigs([connectConfig("a")]);
    const afterConfigs = changes;
    assert.ok(afterConfigs > 0, "expected a change for the new session");

    await sessionNamed("a")?.start();
    assert.ok(changes > afterConfigs, "expected a change for the state transition");
  });

  test("dispose stops every session and channel", async () => {
    registry.setConfigs([connectConfig("a"), connectConfig("b")]);
    await sessionNamed("a")?.start();
    const sessions = registry.sessions as FakeSession[];

    await registry.dispose();

    assert.ok(sessions.every((s) => s.disposed), "every session should be disposed");
    assert.ok(channels.every((c) => c.disposed), "every channel should be disposed");
    assert.deepStrictEqual(registry.sessions, []);
  });
});
