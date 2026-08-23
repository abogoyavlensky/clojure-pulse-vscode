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

/** Grouped per-project view: kind, classpath config + status, libraries. */
const PROJECTS = "clojurePulse/projects";
/** Resolved library list — computed by the server, re-derived per request. */
const EXTERNAL_LIBRARIES = "clojurePulse/externalLibraries";
/** A single jar's flat file-entry list. */
const LIBRARY_ENTRIES = "clojurePulse/libraryEntries";

/** JSON-RPC method-not-found — how an older server answers `PROJECTS`. */
const METHOD_NOT_FOUND = -32601;

type LibraryKind = "jar" | "dir";

/** One resolved library, mirroring the server's `Library` shape. */
interface Library {
  name: string;
  version?: string;
  path: string;
  kind: LibraryKind;
}

type ClasspathStatus =
  | "disabled"
  | "cached"
  | "resolving"
  | "resolved"
  | "unresolved"
  | "error";

/** One project of the workspace, mirroring the server's `PROJECTS` shape. */
interface ProjectInfo {
  /** Workspace-root-relative; `"."` is the root. */
  path: string;
  kind: string;
  classpath: {
    enabled: boolean;
    cmd?: string;
    status: ClasspathStatus;
    /** Present only when `status` is `"error"`. */
    message?: string;
  };
  libraries: Library[];
}

/** A node in the External Libraries tree. */
export type LibNode =
  | { type: "project"; project: ProjectInfo }
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
   * In-flight or resolved root nodes — `PROJECTS` is asked once per refresh,
   * however many times the view repaints. Evicted on failure (generation-
   * guarded, like a jar's entry list) so the next paint can retry.
   */
  private rootNodes: Promise<LibNode[]> | undefined;
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
    /**
     * Told, on every root-load settle, whether any project is still
     * resolving its classpath — what drives the view's progress bar. `false`
     * on the flat fallback and on failures (progress must close, never
     * strand); a load superseded by `refresh()` reports nothing.
     */
    private readonly onRootStatuses: (anyResolving: boolean) => void = () => {},
  ) {}

  /** Clears caches and repaints the tree (refresh triggers call this). */
  refresh(): void {
    this.generation += 1;
    this.jarEntries.clear();
    this.rootNodes = undefined;
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(node: LibNode): vscode.TreeItem {
    switch (node.type) {
      case "project": {
        const { path, kind, classpath } = node.project;
        const isRoot = path === ".";
        const item = new vscode.TreeItem(
          isRoot ? workspaceName() : path,
          // The root project open by default — a single-project workspace
          // reads exactly like the ungrouped panel did.
          isRoot
            ? vscode.TreeItemCollapsibleState.Expanded
            : vscode.TreeItemCollapsibleState.Collapsed,
        );
        // Stable across refreshes, so a status change (resolving → resolved)
        // does not collapse what the user expanded.
        item.id = `clojurePulseProject:${path}`;
        item.description = `${kind} · ${
          classpath.status === "resolving" ? "resolving…" : classpath.status
        }`;
        item.iconPath = new vscode.ThemeIcon(
          classpath.status === "resolving"
            ? "loading~spin"
            : isRoot
              ? "root-folder"
              : "folder",
        );
        // The toggle commands are gated on these in package.json; contributed
        // icons are static, so each direction needs its own context value.
        item.contextValue = classpath.enabled
          ? "clojurePulseProjectEnabled"
          : "clojurePulseProjectDisabled";
        if (classpath.status === "error" && classpath.message) {
          item.tooltip = classpath.message;
        }
        return item;
      }
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
      return this.rootChildren();
    }
    switch (node.type) {
      case "project":
        return node.project.libraries.map((library) => ({
          type: "library",
          library,
        }));
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

  /** The cached root of the tree, requested at most once per refresh. */
  private rootChildren(): Promise<LibNode[]> {
    if (!this.rootNodes) {
      this.rootNodes = this.requestRoot(this.generation);
    }
    return this.rootNodes;
  }

  /**
   * One node per project, from `PROJECTS`. A server too old for that method
   * (and only that — method-not-found) gets today's flat library list; any
   * other failure renders an empty tree, never stale flat data from a server
   * that does support grouping. Failures evict the cache (unless a refresh
   * already replaced it) so the next paint retries.
   */
  private async requestRoot(generation: number): Promise<LibNode[]> {
    try {
      const projects = (await this.sendRequest(PROJECTS, {})) as ProjectInfo[];
      this.reportStatuses(
        generation,
        projects.some((project) => project.classpath?.status === "resolving"),
      );
      return projects.map((project) => ({ type: "project", project }));
    } catch (e) {
      if ((e as { code?: unknown })?.code === METHOD_NOT_FOUND) {
        // A successful fallback stays cached like a grouped result would;
        // only retryable failures below evict.
        const nodes = await this.rootLibraries();
        this.reportStatuses(generation, false);
        return nodes;
      }
      if (generation === this.generation) {
        this.rootNodes = undefined;
      }
      this.log(`External Libraries: failed to load projects: ${errMessage(e)}`);
      this.reportStatuses(generation, false);
      return [];
    }
  }

  /** Reports root statuses unless a refresh() superseded this load — a stale
   *  response must not re-open (or wrongly close) the progress bar. */
  private reportStatuses(generation: number, anyResolving: boolean): void {
    if (generation === this.generation) {
      this.onRootStatuses(anyResolving);
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

/** What the root (`"."`) project node is labeled: the workspace folder. */
function workspaceName(): string {
  return vscode.workspace.workspaceFolders?.[0]?.name ?? ".";
}

/** Forces server-side re-detection and re-resolution. */
const RESCAN = "clojurePulse/rescan";

/**
 * The refresh button's action: ask the server to rescan (re-detect projects,
 * re-resolve classpaths — completion arrives as `librariesChanged`, so no
 * local repaint is needed on success). A server too old for the method gets
 * today's plain repaint; any other failure logs and also repaints, so a
 * broken rescan never leaves a dead button.
 */
export async function rescanOrRefresh(
  sendRequest: SendRequest,
  refresh: () => void,
  log: (message: string) => void = () => {},
): Promise<void> {
  try {
    await sendRequest(RESCAN, {});
  } catch (e) {
    if ((e as { code?: unknown })?.code !== METHOD_NOT_FOUND) {
      log(`External Libraries: rescan failed: ${errMessage(e)}`);
    }
    refresh();
  }
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
