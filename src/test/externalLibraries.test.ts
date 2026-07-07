import * as assert from "assert";
import * as vscode from "vscode";
import { ExternalLibrariesProvider } from "../externalLibraries";

const JAR_LIB = { name: "aero", version: "1.1.6", path: "/abs/to.jar", kind: "jar" };

function labelsOf(provider: ExternalLibrariesProvider, nodes: unknown[]): unknown[] {
  return nodes.map((n) => provider.getTreeItem(n as never).label);
}

suite("ExternalLibrariesProvider", () => {
  test("root libraries render as `name version` (version omitted when absent)", async () => {
    const provider = new ExternalLibrariesProvider((method) => {
      assert.strictEqual(method, "clojurePulse/externalLibraries");
      return Promise.resolve([
        { name: "aero", version: "1.1.6", path: "/a.jar", kind: "jar" },
        { name: "my-local", path: "/some/dir", kind: "dir" },
      ]);
    });

    const roots = await provider.getChildren();
    assert.strictEqual(roots.length, 2);
    const first = provider.getTreeItem(roots[0]);
    assert.strictEqual(first.label, "aero 1.1.6");
    assert.ok(first.iconPath instanceof vscode.ThemeIcon);
    assert.strictEqual(provider.getTreeItem(roots[1]).label, "my-local");
  });

  test("expanding a jar folds entries into folders-before-files, alphabetical", async () => {
    const entries = ["META-INF/MANIFEST.MF", "aero/core.cljc", "aero/impl/walk.cljc"];
    const provider = new ExternalLibrariesProvider((method, param) => {
      if (method === "clojurePulse/externalLibraries") {
        return Promise.resolve([JAR_LIB]);
      }
      assert.strictEqual(method, "clojurePulse/libraryEntries");
      assert.deepStrictEqual(param, { path: "/abs/to.jar" });
      return Promise.resolve(entries);
    });

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
    const provider = new ExternalLibrariesProvider((method) =>
      method === "clojurePulse/externalLibraries"
        ? Promise.resolve([JAR_LIB])
        : Promise.resolve(["aero/impl/walk.cljc"]),
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
    const provider = new ExternalLibrariesProvider((method) => {
      if (method === "clojurePulse/externalLibraries") {
        return Promise.resolve([JAR_LIB]);
      }
      entryCalls += 1;
      return Promise.resolve(["aero/core.cljc", "aero/impl/walk.cljc"]);
    });

    const [jar] = await provider.getChildren();
    const folders = await provider.getChildren(jar); // one request
    await provider.getChildren(folders[0]); // served from cache
    assert.strictEqual(entryCalls, 1);

    provider.refresh();
    const [jar2] = await provider.getChildren();
    await provider.getChildren(jar2); // re-requested after refresh
    assert.strictEqual(entryCalls, 2);
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
      () => Promise.resolve([{ name: "my-local", path: "/some/dir", kind: "dir" }]),
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
