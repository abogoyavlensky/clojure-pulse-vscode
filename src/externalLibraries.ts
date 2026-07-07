import * as vscode from "vscode";

/**
 * Minimal slice of `LanguageClient.sendRequest`, injected so the provider can
 * be unit-tested without a live server. The param shape varies per method
 * (`{}` for the library list, `{ path }` for a jar's entries), so it is left
 * open rather than pinned like `jarContentProvider`'s.
 */
export type SendRequest = (method: string, param: unknown) => Thenable<unknown>;

/** Reads a directory's entries; defaults to `vscode.workspace.fs.readDirectory`. */
export type ReadDirectory = (uri: vscode.Uri) => Thenable<[string, vscode.FileType][]>;

/** Resolved library list — computed by the server, re-derived per request. */
const EXTERNAL_LIBRARIES = "clojurePulse/externalLibraries";
/** A single jar's flat file-entry list. */
const LIBRARY_ENTRIES = "clojurePulse/libraryEntries";

type LibraryKind = "jar" | "dir";

/** One resolved library, mirroring the server's `Library` shape. */
interface Library {
  name: string;
  version?: string;
  path: string;
  kind: LibraryKind;
}

/** A node in the External Libraries tree. */
export type LibNode =
  | { type: "library"; library: Library }
  | { type: "jarFolder"; jarPath: string; prefix: string; name: string }
  | { type: "jarFile"; jarPath: string; entry: string; name: string }
  | { type: "dirEntry"; uri: vscode.Uri; name: string; isDirectory: boolean };

/**
 * Lazy tree of the libraries clj-pulse resolved for the project. Jar libraries
 * are expanded by folding one `libraryEntries` request into a folder tree
 * (cached until `refresh()`); directory libraries are read from disk per node.
 * File leaves open through the existing read-only `jar:` content provider (jar
 * entries) or as ordinary documents (directory entries).
 */
export class ExternalLibrariesProvider implements vscode.TreeDataProvider<LibNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  /**
   * In-flight or resolved jar entry lists, keyed by jar path, invalidated by
   * `refresh()`. Caching the promise (not the resolved value) means concurrent
   * expands of one jar share a single request.
   */
  private readonly jarEntries = new Map<string, Promise<string[]>>();
  /**
   * Bumped by `refresh()` so a request that resolves *after* a refresh can't
   * repopulate (or evict from) the freshly-cleared cache.
   */
  private generation = 0;

  constructor(
    private readonly sendRequest: SendRequest,
    private readonly readDirectory: ReadDirectory = (uri) =>
      vscode.workspace.fs.readDirectory(uri),
    private readonly log: (message: string) => void = () => {},
  ) {}

  /** Clears caches and repaints the tree (refresh triggers call this). */
  refresh(): void {
    this.generation += 1;
    this.jarEntries.clear();
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(node: LibNode): vscode.TreeItem {
    switch (node.type) {
      case "library": {
        const { name, version, path } = node.library;
        const item = new vscode.TreeItem(
          version ? `${name} ${version}` : name,
          vscode.TreeItemCollapsibleState.Collapsed,
        );
        item.iconPath = new vscode.ThemeIcon("library");
        item.tooltip = path;
        return item;
      }
      case "jarFolder": {
        const item = new vscode.TreeItem(node.name, vscode.TreeItemCollapsibleState.Collapsed);
        item.iconPath = vscode.ThemeIcon.Folder;
        return item;
      }
      case "jarFile": {
        const uri = jarEntryUri(node.jarPath, node.entry);
        const item = new vscode.TreeItem(node.name, vscode.TreeItemCollapsibleState.None);
        item.resourceUri = uri;
        item.command = {
          command: "vscode.open",
          title: "Open Library File",
          arguments: [uri],
        };
        return item;
      }
      case "dirEntry": {
        const item = new vscode.TreeItem(
          node.name,
          node.isDirectory
            ? vscode.TreeItemCollapsibleState.Collapsed
            : vscode.TreeItemCollapsibleState.None,
        );
        item.resourceUri = node.uri;
        if (node.isDirectory) {
          item.iconPath = vscode.ThemeIcon.Folder;
        } else {
          item.command = {
            command: "vscode.open",
            title: "Open Library File",
            arguments: [node.uri],
          };
        }
        return item;
      }
    }
  }

  async getChildren(node?: LibNode): Promise<LibNode[]> {
    if (!node) {
      return this.rootLibraries();
    }
    switch (node.type) {
      case "library":
        return node.library.kind === "jar"
          ? this.jarChildren(node.library.path, "")
          : this.dirChildren(vscode.Uri.file(node.library.path));
      case "jarFolder":
        return this.jarChildren(node.jarPath, node.prefix);
      case "dirEntry":
        return node.isDirectory ? this.dirChildren(node.uri) : [];
      case "jarFile":
        return [];
    }
  }

  private async rootLibraries(): Promise<LibNode[]> {
    try {
      const libs = (await this.sendRequest(EXTERNAL_LIBRARIES, {})) as Library[];
      return libs.map((library) => ({ type: "library", library }));
    } catch (e) {
      this.log(`External Libraries: failed to load libraries: ${errMessage(e)}`);
      return [];
    }
  }

  private async jarChildren(jarPath: string, prefix: string): Promise<LibNode[]> {
    return foldJarLevel(await this.entriesFor(jarPath), jarPath, prefix);
  }

  /**
   * A jar's flat entry list, requested at most once per jar until `refresh()`.
   * The in-flight promise is cached synchronously so concurrent expands reuse
   * it; a failed request is evicted so a later expand can retry.
   */
  private entriesFor(jarPath: string): Promise<string[]> {
    const cached = this.jarEntries.get(jarPath);
    if (cached) {
      return cached;
    }
    const pending = this.requestEntries(jarPath, this.generation);
    this.jarEntries.set(jarPath, pending);
    return pending;
  }

  private async requestEntries(jarPath: string, generation: number): Promise<string[]> {
    try {
      return (await this.sendRequest(LIBRARY_ENTRIES, { path: jarPath })) as string[];
    } catch (e) {
      this.log(`External Libraries: failed to list ${jarPath}: ${errMessage(e)}`);
      // Allow a retry on the next expand — unless a refresh already replaced
      // this cache entry, in which case leave the newer request in place.
      if (generation === this.generation) {
        this.jarEntries.delete(jarPath);
      }
      return [];
    }
  }

  private async dirChildren(dir: vscode.Uri): Promise<LibNode[]> {
    let entries: [string, vscode.FileType][];
    try {
      entries = await this.readDirectory(dir);
    } catch (e) {
      this.log(`External Libraries: failed to read ${dir.fsPath}: ${errMessage(e)}`);
      return [];
    }
    const nodes = entries.map(([name, fileType]) => ({
      type: "dirEntry" as const,
      uri: vscode.Uri.joinPath(dir, name),
      name,
      isDirectory: (fileType & vscode.FileType.Directory) !== 0,
    }));
    nodes.sort(compareDirEntries);
    return nodes;
  }
}

/**
 * Folds the flat entry list into the immediate children under `prefix`:
 * an entry with a further `/` contributes a folder, one without is a file.
 * Folders sort before files; both alphabetically.
 */
function foldJarLevel(entries: string[], jarPath: string, prefix: string): LibNode[] {
  const folders = new Set<string>();
  const files = new Set<string>();
  for (const entry of entries) {
    if (!entry.startsWith(prefix)) {
      continue;
    }
    const rest = entry.slice(prefix.length);
    if (rest.length === 0) {
      continue;
    }
    const slash = rest.indexOf("/");
    if (slash === -1) {
      files.add(rest);
    } else {
      folders.add(rest.slice(0, slash));
    }
  }
  const folderNodes: LibNode[] = [...folders]
    .sort(byName)
    .map((name) => ({ type: "jarFolder", jarPath, prefix: `${prefix}${name}/`, name }));
  const fileNodes: LibNode[] = [...files]
    .sort(byName)
    .map((name) => ({ type: "jarFile", jarPath, entry: `${prefix}${name}`, name }));
  return [...folderNodes, ...fileNodes];
}

/**
 * Builds the `jar:` URI the read-only content provider serves — exactly the
 * shape the server's `uri::from_index_path` produces, e.g.
 * `jar:file:///x.jar!/aero/core.cljc`.
 */
function jarEntryUri(jarPath: string, entry: string): vscode.Uri {
  const fileUri = vscode.Uri.file(jarPath);
  return vscode.Uri.parse(`jar:${fileUri.toString()}!/${entry}`);
}

function compareDirEntries(
  a: { name: string; isDirectory: boolean },
  b: { name: string; isDirectory: boolean },
): number {
  if (a.isDirectory !== b.isDirectory) {
    return a.isDirectory ? -1 : 1;
  }
  return byName(a.name, b.name);
}

function byName(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
