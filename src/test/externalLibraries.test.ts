import * as assert from "assert";
import * as vscode from "vscode";
import { ExternalLibrariesProvider, SendRequest } from "../externalLibraries";

const JAR_LIB = { name: "aero", version: "1.1.6", path: "/abs/to.jar", kind: "jar" };

function labelsOf(provider: ExternalLibrariesProvider, nodes: unknown[]): unknown[] {
  return nodes.map((n) => provider.getTreeItem(n as never).label);
}

/** JSON-RPC method-not-found, as an older server without `clojurePulse/projects` answers. */
function methodNotFound(): Promise<never> {
  return Promise.reject(Object.assign(new Error("method not found"), { code: -32601 }));
}

/** Wraps a fake server without `clojurePulse/projects` — the fallback path. */
function flatServer(handler: SendRequest): SendRequest {
  return (method, param) =>
    method === "clojurePulse/projects" ? methodNotFound() : handler(method, param);
}

function project(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    path: "apps/backend",
    kind: "deps",
    classpath: { enabled: true, cmd: "clojure -Spath", status: "resolved" },
    libraries: [],
    ...overrides,
  };
}

suite("ExternalLibrariesProvider", () => {
  test("root libraries render as `name version` (version omitted when absent)", async () => {
    const provider = new ExternalLibrariesProvider(
      flatServer((method) => {
        assert.strictEqual(method, "clojurePulse/externalLibraries");
        return Promise.resolve([
          { name: "aero", version: "1.1.6", path: "/a.jar", kind: "jar" },
          { name: "my-local", path: "/some/dir", kind: "dir" },
        ]);
      }),
    );

    const roots = await provider.getChildren();
    assert.strictEqual(roots.length, 2);
    const first = provider.getTreeItem(roots[0]);
    assert.strictEqual(first.label, "aero 1.1.6");
    assert.ok(first.iconPath instanceof vscode.ThemeIcon);
    assert.strictEqual(provider.getTreeItem(roots[1]).label, "my-local");
  });

  test("expanding a jar folds entries into folders-before-files, alphabetical", async () => {
    const entries = ["META-INF/MANIFEST.MF", "aero/core.cljc", "aero/impl/walk.cljc"];
    const provider = new ExternalLibrariesProvider(
      flatServer((method, param) => {
        if (method === "clojurePulse/externalLibraries") {
          return Promise.resolve([JAR_LIB]);
        }
        assert.strictEqual(method, "clojurePulse/libraryEntries");
        assert.deepStrictEqual(param, { path: "/abs/to.jar" });
        return Promise.resolve(entries);
      }),
    );

    const [jar] = await provider.getChildren();
    const top = await provider.getChildren(jar);
    // Both `META-INF` and `aero` are folders at the root; alphabetical.
    assert.deepStrictEqual(labelsOf(provider, top), ["META-INF", "aero"]);

    const aero = top.find((n) => provider.getTreeItem(n).label === "aero");
    const aeroChildren = await provider.getChildren(aero);
    // Nested: folder `impl` sorts before file `core.cljc`.
    assert.deepStrictEqual(labelsOf(provider, aeroChildren), ["impl", "core.cljc"]);
  });

  test("a jar file leaf opens the exact jar: URI read-only via vscode.open", async () => {
    const provider = new ExternalLibrariesProvider(
      flatServer((method) =>
        method === "clojurePulse/externalLibraries"
          ? Promise.resolve([JAR_LIB])
          : Promise.resolve(["aero/impl/walk.cljc"]),
      ),
    );

    const [jar] = await provider.getChildren();
    const [aero] = await provider.getChildren(jar);
    const [impl] = await provider.getChildren(aero);
    const [file] = await provider.getChildren(impl);

    const item = provider.getTreeItem(file);
    const expected = vscode.Uri.parse("jar:file:///abs/to.jar!/aero/impl/walk.cljc");
    assert.ok(item.command, "file node must carry an open command");
    assert.strictEqual(item.command.command, "vscode.open");
    const arg = (item.command.arguments ?? [])[0] as vscode.Uri;
    assert.strictEqual(arg.toString(), expected.toString());
    assert.strictEqual(item.resourceUri?.toString(), expected.toString());
  });

  test("libraryEntries is requested once per jar until refresh()", async () => {
    let entryCalls = 0;
    const provider = new ExternalLibrariesProvider(
      flatServer((method) => {
        if (method === "clojurePulse/externalLibraries") {
          return Promise.resolve([JAR_LIB]);
        }
        entryCalls += 1;
        return Promise.resolve(["aero/core.cljc", "aero/impl/walk.cljc"]);
      }),
    );

    const [jar] = await provider.getChildren();
    const folders = await provider.getChildren(jar); // one request
    await provider.getChildren(folders[0]); // served from cache
    assert.strictEqual(entryCalls, 1);

    provider.refresh();
    const [jar2] = await provider.getChildren();
    await provider.getChildren(jar2); // re-requested after refresh
    assert.strictEqual(entryCalls, 2);
  });

  test("concurrent expands of the same jar share a single request", async () => {
    let entryCalls = 0;
    let resolveEntries: (v: string[]) => void = () => undefined;
    const provider = new ExternalLibrariesProvider(
      flatServer((method) => {
        if (method === "clojurePulse/externalLibraries") {
          return Promise.resolve([JAR_LIB]);
        }
        entryCalls += 1;
        return new Promise<string[]>((res) => {
          resolveEntries = res;
        });
      }),
    );

    const [jar] = await provider.getChildren();
    // Two expands before the first request resolves must reuse one request.
    const first = provider.getChildren(jar);
    const second = provider.getChildren(jar);
    resolveEntries(["aero/core.cljc"]);
    await Promise.all([first, second]);
    assert.strictEqual(entryCalls, 1);
  });

  test("a rejected request yields empty children (no throw)", async () => {
    const provider = new ExternalLibrariesProvider(() =>
      Promise.reject(new Error("server not running")),
    );
    assert.deepStrictEqual(await provider.getChildren(), []);
  });

  test("dir libraries read children via the injected directory reader", async () => {
    const reads: string[] = [];
    const dirEntries: [string, vscode.FileType][] = [
      ["core.clj", vscode.FileType.File],
      ["util", vscode.FileType.Directory],
    ];
    const provider = new ExternalLibrariesProvider(
      flatServer(() =>
        Promise.resolve([{ name: "my-local", path: "/some/dir", kind: "dir" }]),
      ),
      (uri) => {
        reads.push(uri.fsPath);
        return Promise.resolve(dirEntries);
      },
    );

    const [lib] = await provider.getChildren();
    const children = await provider.getChildren(lib);
    assert.deepStrictEqual(reads, ["/some/dir"]);
    // Folder `util` before file `core.clj`.
    assert.deepStrictEqual(labelsOf(provider, children), ["util", "core.clj"]);
  });
});

suite("ExternalLibrariesProvider — grouped by project", () => {
  test("root-level children are project nodes in server order", async () => {
    const provider = new ExternalLibrariesProvider(() =>
      Promise.resolve([
        project({ path: "." }),
        project({ path: "apps/backend" }),
        project({ path: "libs/common" }),
      ]),
    );

    const roots = await provider.getChildren();
    assert.strictEqual(roots.length, 3);
    const labels = labelsOf(provider, roots);
    // The root project shows the workspace folder's name, not ".".
    const workspaceName = vscode.workspace.workspaceFolders?.[0]?.name ?? ".";
    assert.deepStrictEqual(labels, [workspaceName, "apps/backend", "libs/common"]);

    const rootItem = provider.getTreeItem(roots[0]);
    const subItem = provider.getTreeItem(roots[1]);
    assert.deepStrictEqual(rootItem.iconPath, new vscode.ThemeIcon("root-folder"));
    assert.deepStrictEqual(subItem.iconPath, new vscode.ThemeIcon("folder"));
  });

  test("description reflects kind and status; contextValue encodes the toggle", async () => {
    const provider = new ExternalLibrariesProvider(() =>
      Promise.resolve([
        project({ path: ".", kind: "deps" }),
        project({
          path: "apps/api",
          kind: "lein",
          classpath: { enabled: false, status: "disabled" },
        }),
      ]),
    );

    const [root, api] = await provider.getChildren();
    const rootItem = provider.getTreeItem(root);
    assert.strictEqual(rootItem.description, "deps · resolved");
    assert.strictEqual(rootItem.contextValue, "clojurePulseProjectEnabled");
    const apiItem = provider.getTreeItem(api);
    assert.strictEqual(apiItem.description, "lein · disabled");
    assert.strictEqual(apiItem.contextValue, "clojurePulseProjectDisabled");
  });

  test("resolving shows a spinner and an ellipsis", async () => {
    const provider = new ExternalLibrariesProvider(() =>
      Promise.resolve([
        project({ classpath: { enabled: true, status: "resolving" } }),
      ]),
    );
    const [node] = await provider.getChildren();
    const item = provider.getTreeItem(node);
    assert.strictEqual(item.description, "deps · resolving…");
    assert.deepStrictEqual(item.iconPath, new vscode.ThemeIcon("loading~spin"));
  });

  test("an error status carries the message in the tooltip", async () => {
    const provider = new ExternalLibrariesProvider(() =>
      Promise.resolve([
        project({
          classpath: { enabled: true, status: "error", message: "cmd exited 1" },
        }),
      ]),
    );
    const [node] = await provider.getChildren();
    const item = provider.getTreeItem(node);
    assert.strictEqual(item.description, "deps · error");
    assert.strictEqual(item.tooltip, "cmd exited 1");
  });

  test("a project's children are its libraries as ordinary library nodes", async () => {
    const provider = new ExternalLibrariesProvider((method) => {
      if (method === "clojurePulse/projects") {
        return Promise.resolve([project({ libraries: [JAR_LIB] })]);
      }
      assert.strictEqual(method, "clojurePulse/libraryEntries");
      return Promise.resolve(["aero/core.cljc"]);
    });

    const [proj] = await provider.getChildren();
    const libs = await provider.getChildren(proj);
    assert.deepStrictEqual(labelsOf(provider, libs), ["aero 1.1.6"]);
    // The library node expands exactly like before the grouping.
    const [aeroFolder] = await provider.getChildren(libs[0]);
    assert.strictEqual(provider.getTreeItem(aeroFolder).label, "aero");
  });

  test("projects is requested once per refresh", async () => {
    let calls = 0;
    const provider = new ExternalLibrariesProvider(() => {
      calls += 1;
      return Promise.resolve([project({ path: "." }), project({ path: "apps/x" })]);
    });

    await provider.getChildren();
    await provider.getChildren();
    assert.strictEqual(calls, 1);

    provider.refresh();
    await provider.getChildren();
    assert.strictEqual(calls, 2);
  });

  test("method-not-found falls back to the flat library list", async () => {
    const provider = new ExternalLibrariesProvider(
      flatServer(() => Promise.resolve([JAR_LIB])),
    );
    const roots = await provider.getChildren();
    assert.deepStrictEqual(labelsOf(provider, roots), ["aero 1.1.6"]);
  });

  test("any other rejection renders an empty tree and logs, never the flat list", async () => {
    const log: string[] = [];
    let flatRequested = false;
    const provider = new ExternalLibrariesProvider(
      (method) => {
        if (method === "clojurePulse/externalLibraries") {
          flatRequested = true;
          return Promise.resolve([JAR_LIB]);
        }
        return Promise.reject(new Error("timed out"));
      },
      undefined,
      (message) => log.push(message),
    );

    assert.deepStrictEqual(await provider.getChildren(), []);
    assert.strictEqual(flatRequested, false);
    assert.ok(log.some((line) => line.includes("timed out")));
  });

  test("a failed projects request is retried on the next paint", async () => {
    let calls = 0;
    const provider = new ExternalLibrariesProvider(() => {
      calls += 1;
      return calls === 1
        ? Promise.reject(new Error("not ready"))
        : Promise.resolve([project()]);
    });

    assert.deepStrictEqual(await provider.getChildren(), []);
    const roots = await provider.getChildren();
    assert.strictEqual(roots.length, 1);
  });
});
