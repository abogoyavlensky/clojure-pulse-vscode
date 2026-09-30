import * as vscode from "vscode";
import { matchLibrary, parseQuery } from "./externalLibrariesFilter";

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

/** Pruned libraries and folders open by default up to this many matching files. */
const AUTO_EXPAND_LIMIT = 200;
/** Jar entry requests in flight at once while indexing for a search. */
const INDEX_CONCURRENCY = 16;
/** A directory library's walk stops after this many files. */
const DIR_INDEX_LIMIT = 5000;

type LibraryKind = "jar" | "dir";

/** One resolved library, mirroring the server's `Library` shape. */
interface Library {
  name: string;
  version?: string;
  path: string;
  kind: LibraryKind;
}

type ClasspathStatus = "disabled" | "cached" | "resolving" | "resolved" | "unresolved" | "error";

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

/**
 * Carried only by the expandable nodes of a filtered tree: an explicit tree-item
 * id (embedding the query, so a new query starts from the computed expansion)
 * and whether the node opens expanded.
 */
interface FilterMeta {
  id?: string;
  expanded?: boolean;
}

/**
 * A node in the External Libraries tree. The optional fields appear only on
 * filtered nodes: a project's surviving libraries, a library's or folder's
 * pruned entry list (a library without `matches` is shown whole), and the
 * pruned list a directory entry folds its children from instead of disk.
 */
export type LibNode = (
  | { type: "project"; project: ProjectInfo; children?: LibNode[] }
  | { type: "library"; library: Library; matches?: string[] }
  | { type: "jarFolder"; jarPath: string; prefix: string; name: string; entries?: string[] }
  | { type: "jarFile"; jarPath: string; entry: string; name: string }
  | {
      type: "dirEntry";
      uri: vscode.Uri;
      name: string;
      isDirectory: boolean;
      pruned?: { root: vscode.Uri; entries: string[]; prefix: string };
    }
) &
  FilterMeta;

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
  /** The active search query, trimmed; `""` when the tree is unfiltered. */
  private query = "";
  /**
   * The filtered root for one query and generation — recomputed when either
   * changes, so repaints under an unchanged filter cost nothing.
   */
  private filteredRoot: { key: string; nodes: Promise<LibNode[]> } | undefined;
  /** Directory libraries' walked file lists, keyed by path, until `refresh()`. */
  private readonly dirFiles = new Map<string, Promise<string[]>>();

  constructor(
    private readonly sendRequest: SendRequest,
    private readonly readDirectory: ReadDirectory = (uri) => vscode.workspace.fs.readDirectory(uri),
    private readonly log: (message: string) => void = () => {},
    /**
     * Told, on every root-load settle, whether any project is still
     * resolving its classpath — what drives the view's progress bar. `false`
     * on the flat fallback and on failures (progress must close, never
     * strand); a load superseded by `refresh()` reports nothing.
     */
    private readonly onRootStatuses: (anyResolving: boolean) => void = () => {},
  ) {}

  /**
   * Clears caches and repaints the tree (refresh triggers call this). The
   * search query survives: the new data is filtered again.
   */
  refresh(): void {
    this.generation += 1;
    this.jarEntries.clear();
    this.dirFiles.clear();
    this.rootNodes = undefined;
    this.filteredRoot = undefined;
    this._onDidChangeTreeData.fire();
  }

  /** The active query, `""` when unfiltered. */
  get filter(): string {
    return this.query;
  }

  /**
   * Sets (or, with a blank query, clears) the filter and repaints. Settles
   * once the filtered root for this query has been computed; never rejects.
   */
  setFilter(query: string): Promise<void> {
    this.query = parseQuery(query).length > 0 ? query.trim() : "";
    this._onDidChangeTreeData.fire();
    return this.query ? this.filteredRootNodes().then(() => undefined) : Promise.resolve();
  }

  getTreeItem(node: LibNode): vscode.TreeItem {
    const item = this.baseTreeItem(node);
    if (node.id !== undefined) {
      item.id = node.id;
    }
    if (node.expanded !== undefined) {
      item.collapsibleState = node.expanded
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.Collapsed;
    }
    return item;
  }

  private baseTreeItem(node: LibNode): vscode.TreeItem {
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
          classpath.status === "resolving" ? "loading~spin" : isRoot ? "root-folder" : "folder",
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
        const item = new vscode.TreeItem(
          libraryLabel(node.library),
          vscode.TreeItemCollapsibleState.Collapsed,
        );
        item.iconPath = new vscode.ThemeIcon("library");
        item.tooltip = node.library.path;
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
      return this.query ? this.filteredRootNodes() : this.rootChildren();
    }
    switch (node.type) {
      case "project":
        return (
          node.children ??
          node.project.libraries.map((library) => ({
            type: "library",
            library,
          }))
        );
      case "library": {
        const { kind, path } = node.library;
        if (node.matches) {
          return kind === "jar"
            ? prunedJarLevel(path, node.matches, "", node)
            : prunedDirLevel(vscode.Uri.file(path), node.matches, "", node);
        }
        return kind === "jar"
          ? this.jarChildren(path, "")
          : this.dirChildren(vscode.Uri.file(path));
      }
      case "jarFolder":
        return node.entries
          ? prunedJarLevel(node.jarPath, node.entries, node.prefix, node)
          : this.jarChildren(node.jarPath, node.prefix);
      case "dirEntry":
        if (node.pruned) {
          return prunedDirLevel(node.pruned.root, node.pruned.entries, node.pruned.prefix, node);
        }
        return node.isDirectory ? this.dirChildren(node.uri) : [];
      case "jarFile":
        return [];
    }
  }

  /** The filtered root for the current query and generation, cached. */
  private filteredRootNodes(): Promise<LibNode[]> {
    const key = `${this.generation}\0${this.query}`;
    if (this.filteredRoot?.key !== key) {
      this.filteredRoot = { key, nodes: this.buildFilteredRoot(this.query) };
    }
    return this.filteredRoot.nodes;
  }

  /**
   * Loads the usual root (projects, or the flat fallback), indexes every
   * library the query does not already match by name, and keeps what
   * matches: whole libraries on a label match, pruned ones on file matches,
   * and only the projects left with a library. A build superseded by a newer
   * query or a refresh still resolves — to its stale caller only.
   */
  private async buildFilteredRoot(query: string): Promise<LibNode[]> {
    const terms = parseQuery(query);
    const roots = await this.rootChildren();
    const groups: { projectPath: string; project?: ProjectInfo; libraries: Library[] }[] =
      roots.map((node) =>
        node.type === "project"
          ? {
              projectPath: node.project.path,
              project: node.project,
              libraries: node.project.libraries,
            }
          : { projectPath: "", libraries: node.type === "library" ? [node.library] : [] },
      );

    const toIndex = new Map<string, Library>();
    for (const { libraries } of groups) {
      for (const library of libraries) {
        if (!matchLibrary(terms, libraryLabel(library), [])) {
          toIndex.set(library.path, library);
        }
      }
    }
    const index = new Map<string, string[]>();
    await mapLimit([...toIndex.values()], INDEX_CONCURRENCY, async (library) => {
      index.set(
        library.path,
        library.kind === "jar"
          ? await this.entriesFor(library.path)
          : await this.dirFilesFor(library.path),
      );
    });

    let matchedFiles = 0;
    const matched = groups.map((group) => ({
      ...group,
      libraries: group.libraries.flatMap((library) => {
        const match = matchLibrary(terms, libraryLabel(library), index.get(library.path) ?? []);
        if (!match) {
          return [];
        }
        if (!match.whole) {
          matchedFiles += match.entries.length;
        }
        return [{ library, match }];
      }),
    }));
    const expanded = matchedFiles <= AUTO_EXPAND_LIMIT;

    const nodes: LibNode[] = [];
    for (const { projectPath, project, libraries } of matched) {
      const libraryNodes: LibNode[] = libraries.map(({ library, match }) => ({
        type: "library",
        library,
        ...(match.whole ? {} : { matches: match.entries }),
        id: `clojurePulseFilter:${query}:${projectPath}:${library.path}:`,
        expanded: match.whole ? false : expanded,
      }));
      if (!project) {
        nodes.push(...libraryNodes);
      } else if (libraryNodes.length > 0) {
        nodes.push({
          type: "project",
          project,
          children: libraryNodes,
          id: `clojurePulseFilter:${query}:${projectPath}`,
          expanded: true,
        });
      }
    }
    return nodes;
  }

  /** A directory library's file list, walked at most once until `refresh()`. */
  private dirFilesFor(path: string): Promise<string[]> {
    let files = this.dirFiles.get(path);
    if (!files) {
      files = this.walkDir(vscode.Uri.file(path));
      this.dirFiles.set(path, files);
    }
    return files;
  }

  /**
   * `/`-separated paths of the files under `root`. Skips dot-directories and
   * never descends into a symlinked directory (which rules out cycles); stops
   * at `DIR_INDEX_LIMIT` files. Unreadable directories are logged and skipped.
   */
  private async walkDir(root: vscode.Uri): Promise<string[]> {
    const files: string[] = [];
    const pending = [""];
    let truncated = false;
    while (pending.length > 0 && !truncated) {
      const dir = pending.shift() as string;
      let entries: [string, vscode.FileType][];
      try {
        entries = await this.readDirectory(dir ? vscode.Uri.joinPath(root, dir) : root);
      } catch (e) {
        this.log(`External Libraries: failed to read ${root.fsPath}/${dir}: ${errMessage(e)}`);
        continue;
      }
      for (const [name, fileType] of entries) {
        const path = dir ? `${dir}/${name}` : name;
        if ((fileType & vscode.FileType.Directory) !== 0) {
          if ((fileType & vscode.FileType.SymbolicLink) === 0 && !name.startsWith(".")) {
            pending.push(path);
          }
        } else if (files.length >= DIR_INDEX_LIMIT) {
          truncated = true;
          break;
        } else {
          files.push(path);
        }
      }
    }
    if (truncated) {
      this.log(
        `External Libraries: search indexes only the first ${DIR_INDEX_LIMIT} files of ${root.fsPath}`,
      );
    }
    return files;
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
 * Folds a flat entry list into the immediate children under `prefix`: an
 * entry with a further `/` contributes a folder name, one without a file name.
 * Both come back sorted alphabetically.
 */
function foldLevel(entries: string[], prefix: string): { folders: string[]; files: string[] } {
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
  return { folders: [...folders].sort(byName), files: [...files].sort(byName) };
}

/** A jar's children under `prefix`: folders before files, both alphabetical. */
function foldJarLevel(entries: string[], jarPath: string, prefix: string): LibNode[] {
  const { folders, files } = foldLevel(entries, prefix);
  return [
    ...folders.map((name): LibNode => ({
      type: "jarFolder",
      jarPath,
      prefix: `${prefix}${name}/`,
      name,
    })),
    ...files.map((name): LibNode => ({
      type: "jarFile",
      jarPath,
      entry: `${prefix}${name}`,
      name,
    })),
  ];
}

/**
 * One level of a pruned jar library. Folders carry the pruned list down and
 * derive their ids from the parent's, so every level of the filtered tree has
 * a unique, query-specific id and the parent's expansion.
 */
function prunedJarLevel(
  jarPath: string,
  entries: string[],
  prefix: string,
  parent: FilterMeta,
): LibNode[] {
  return foldJarLevel(entries, jarPath, prefix).map((node) =>
    node.type === "jarFolder"
      ? { ...node, entries, id: `${parent.id ?? ""}${node.name}/`, expanded: parent.expanded }
      : node,
  );
}

/** One level of a pruned directory library, folded from its walked file list. */
function prunedDirLevel(
  root: vscode.Uri,
  entries: string[],
  prefix: string,
  parent: FilterMeta,
): LibNode[] {
  const { folders, files } = foldLevel(entries, prefix);
  return [
    ...folders.map((name): LibNode => ({
      type: "dirEntry",
      uri: vscode.Uri.joinPath(root, `${prefix}${name}`),
      name,
      isDirectory: true,
      pruned: { root, entries, prefix: `${prefix}${name}/` },
      id: `${parent.id ?? ""}${name}/`,
      expanded: parent.expanded,
    })),
    ...files.map((name): LibNode => ({
      type: "dirEntry",
      uri: vscode.Uri.joinPath(root, `${prefix}${name}`),
      name,
      isDirectory: false,
    })),
  ];
}

/** A library row's text, and what a search matches its name against. */
function libraryLabel({ name, version }: Library): string {
  return version ? `${name} ${version}` : name;
}

/** Maps `items` through `fn` with at most `limit` calls in flight. */
async function mapLimit<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      await fn(items[next++]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
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
 *
 * Resolves `true` when the server accepted a rescan (its response arrives
 * before the work, so this is the caller's cue to show progress right away);
 * `false` on either fallback path.
 */
export async function rescanOrRefresh(
  sendRequest: SendRequest,
  refresh: () => void,
  log: (message: string) => void = () => {},
): Promise<boolean> {
  try {
    await sendRequest(RESCAN, {});
    return true;
  } catch (e) {
    if ((e as { code?: unknown })?.code !== METHOD_NOT_FOUND) {
      log(`External Libraries: rescan failed: ${errMessage(e)}`);
    }
    refresh();
    return false;
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
