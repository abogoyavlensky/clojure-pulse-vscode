import * as assert from "assert";
import { ReplConnectionInfo } from "../repl/connectionManager";
import { ConnectReplConfig, CreateReplConfig } from "../repl/replConfig";
import { ReplSessionState } from "../repl/replSession";
import {
  presentSession,
  ReplTreeProvider,
  ReplTreeSource,
  SessionView,
} from "../repl/replTree";

const createConfig: CreateReplConfig = {
  name: "dev",
  type: "create",
  command: "clojure -M:nrepl",
  cwd: ".",
};

const connectConfig: ConnectReplConfig = {
  name: "staging",
  type: "connect",
  host: "example.test",
  port: 7888,
};

function view(
  config: CreateReplConfig | ConnectReplConfig,
  state: ReplSessionState,
  info?: ReplConnectionInfo,
): SessionView {
  return { name: config.name, config, state, connectionInfo: info };
}

suite("presentSession", () => {
  test("a stopped create config offers to start", () => {
    const item = presentSession(view(createConfig, "stopped"), {
      isActive: false,
      isAdHoc: false,
    });
    assert.strictEqual(item.label, "dev");
    assert.strictEqual(item.description, "stopped");
    assert.strictEqual(item.contextValue, "replCreateStopped");
    assert.ok(item.tooltip.includes("clojure -M:nrepl"), item.tooltip);
  });

  test("a starting create config spins and offers to stop", () => {
    const item = presentSession(view(createConfig, "starting"), {
      isActive: false,
      isAdHoc: false,
    });
    assert.strictEqual(item.description, "starting");
    assert.strictEqual(item.icon, "loading~spin");
    assert.strictEqual(item.contextValue, "replCreateRunning");
  });

  test("a connecting session spins", () => {
    const item = presentSession(view(connectConfig, "connecting"), {
      isActive: false,
      isAdHoc: false,
    });
    assert.strictEqual(item.description, "connecting");
    assert.strictEqual(item.icon, "loading~spin");
    assert.strictEqual(item.contextValue, "replConnectConnected");
  });

  test("a connected session shows its port", () => {
    const item = presentSession(
      view(connectConfig, "connected", { host: "example.test", port: 7888 }),
      { isActive: false, isAdHoc: false },
    );
    assert.strictEqual(item.description, "connected :7888");
    assert.strictEqual(item.icon, "circle-outline");
    assert.strictEqual(item.contextValue, "replConnectConnected");
  });

  test("the active session is marked with a filled icon", () => {
    const item = presentSession(
      view(createConfig, "connected", { host: "localhost", port: 7888 }),
      { isActive: true, isAdHoc: false },
    );
    assert.strictEqual(item.icon, "circle-filled");
    assert.strictEqual(item.contextValue, "replCreateRunning");
  });

  test("a stopped connect config is disconnected, not stopped-with-a-process", () => {
    const item = presentSession(view(connectConfig, "stopped"), {
      isActive: false,
      isAdHoc: false,
    });
    assert.strictEqual(item.contextValue, "replConnectStopped");
    assert.strictEqual(item.icon, "debug-disconnect");
    assert.ok(item.tooltip.includes("example.test:7888"), item.tooltip);
  });

  test("an ad-hoc session gets its own context value", () => {
    const adHoc: ConnectReplConfig = {
      name: "127.0.0.1:7890",
      type: "connect",
      host: "127.0.0.1",
      port: 7890,
    };
    const item = presentSession(
      view(adHoc, "connected", { host: "127.0.0.1", port: 7890 }),
      { isActive: true, isAdHoc: true },
    );
    assert.strictEqual(item.contextValue, "replAdHoc");
    assert.strictEqual(item.label, "127.0.0.1:7890");
  });

  test("a port-file connect config names the file in its tooltip", () => {
    const fromFile: ConnectReplConfig = {
      name: "local",
      type: "connect",
      host: "localhost",
      port: ".nrepl-port",
    };
    const item = presentSession(view(fromFile, "stopped"), {
      isActive: false,
      isAdHoc: false,
    });
    assert.ok(item.tooltip.includes(".nrepl-port"), item.tooltip);
  });
});

suite("ReplTreeProvider", () => {
  function source(sessions: SessionView[], activeName?: string): ReplTreeSource {
    return {
      sessions,
      get active() {
        return sessions.find((s) => s.name === activeName);
      },
      isAdHoc: (name: string) => name.includes(":"),
      onDidChange(listener: () => void) {
        listeners.push(listener);
      },
    };
  }
  let listeners: Array<() => void> = [];

  setup(() => {
    listeners = [];
  });

  test("lists one node per session, in registry order", async () => {
    const provider = new ReplTreeProvider(
      source([view(createConfig, "stopped"), view(connectConfig, "connected")]),
    );

    const nodes = await provider.getChildren();

    assert.deepStrictEqual(
      nodes.map((node) => node.name),
      ["dev", "staging"],
    );
  });

  test("tree items open the session's output on click", async () => {
    const provider = new ReplTreeProvider(source([view(createConfig, "stopped")]));

    const [node] = await provider.getChildren();
    const item = provider.getTreeItem(node);

    assert.strictEqual(item.label, "dev");
    assert.strictEqual(item.description, "stopped");
    assert.strictEqual(item.contextValue, "replCreateStopped");
    assert.strictEqual(item.command?.command, "clojurePulse.showReplOutput");
    assert.deepStrictEqual(item.command?.arguments, ["dev"]);
  });

  test("marks the active session", async () => {
    const provider = new ReplTreeProvider(
      source(
        [
          view(createConfig, "connected", { host: "localhost", port: 1 }),
          view(connectConfig, "connected", { host: "example.test", port: 7888 }),
        ],
        "staging",
      ),
    );

    const nodes = await provider.getChildren();
    const items = nodes.map((node) => provider.getTreeItem(node));

    assert.strictEqual(iconId(items[0]), "circle-outline");
    assert.strictEqual(iconId(items[1]), "circle-filled");
  });

  test("repaints when the registry changes", async () => {
    const provider = new ReplTreeProvider(source([]));
    let repaints = 0;
    provider.onDidChangeTreeData(() => (repaints += 1));

    for (const listener of listeners) {
      listener();
    }

    assert.strictEqual(repaints, 1);
  });

  test("sessions have no children", async () => {
    const provider = new ReplTreeProvider(source([view(createConfig, "stopped")]));
    const [node] = await provider.getChildren();
    assert.deepStrictEqual(await provider.getChildren(node), []);
  });
});

function iconId(item: { iconPath?: unknown }): string | undefined {
  const icon = item.iconPath as { id?: string } | undefined;
  return icon?.id;
}
