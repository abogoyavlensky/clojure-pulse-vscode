/**
 * The `clojurePulse.projects` configuration model: how the raw settings value
 * is validated, how the flat editor-facing keys map to the server's nested
 * config shape, and how the per-project toggle rewrites the raw value. Pure
 * (no `vscode` import) so every rule here is unit-testable.
 */

/** One validated entry of `clojurePulse.projects`. */
export interface ProjectSetting {
  /** Workspace-root-relative, normalized; `"."` is the root. */
  path: string;
  classpathEnabled?: boolean;
  classpathCommand?: string;
}

export interface ParsedProjects {
  entries: ProjectSetting[];
  /** One message per skipped entry, for the extension's log channel. */
  warnings: string[];
}

/**
 * Canonical form of a project path, so `./foo`, `foo/`, `foo\bar`, and ` foo `
 * all name the same project — both against the server's `rel_path` and
 * between entries. Mirrors the server's own normalization (separators become
 * `/`, `./` and trailing slashes drop, empty means root).
 */
export function normalizeProjectPath(path: string): string {
  let p = path.trim().replace(/\\/g, "/");
  while (p.startsWith("./")) {
    p = p.slice(2);
  }
  while (p.endsWith("/") && p.length > 1) {
    p = p.slice(0, -1);
  }
  return p === "" || p === "/" ? "." : p;
}

/**
 * Validates the raw `clojurePulse.projects` value. Invalid entries are
 * skipped with a warning rather than failing the whole list, so one bad
 * hand-edit never breaks the rest (same policy as REPL configurations).
 */
export function parseProjects(raw: unknown): ParsedProjects {
  if (raw === undefined || raw === null) {
    return { entries: [], warnings: [] };
  }
  if (!Array.isArray(raw)) {
    return { entries: [], warnings: ["clojurePulse.projects must be an array."] };
  }

  const entries: ProjectSetting[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();

  raw.forEach((item, index) => {
    const skip = (reason: string): void => {
      warnings.push(`Skipped project entry ${describe(item, index)}: ${reason}`);
    };

    const invalid = entryProblem(item);
    if (invalid) {
      skip(invalid);
      return;
    }
    const entry = item as Record<string, unknown>;
    const path = normalizeProjectPath(entry.path as string);
    if (seen.has(path)) {
      skip(`duplicate path "${path}".`);
      return;
    }

    seen.add(path);
    const parsed: ProjectSetting = { path };
    // Types guaranteed by entryProblem above.
    if (entry.classpathEnabled !== undefined) {
      parsed.classpathEnabled = entry.classpathEnabled as boolean;
    }
    if (entry.classpathCommand !== undefined) {
      parsed.classpathCommand = entry.classpathCommand as string;
    }
    entries.push(parsed);
  });

  return { entries, warnings };
}

/** One project entry in the shape the server reads. */
export interface ServerProjectEntry {
  path: string;
  classpath?: { enabled?: boolean; cmd?: string };
}

/**
 * The config object sent to the server — as `initializationOptions` and,
 * wrapped in `{clojurePulse: ...}`, as `didChangeConfiguration` settings.
 * Keys the user omitted stay omitted: the server owns the defaults.
 */
export function toServerConfig(entries: ProjectSetting[]): {
  projects: ServerProjectEntry[];
} {
  return {
    projects: entries.map((entry) => {
      const mapped: ServerProjectEntry = { path: entry.path };
      if (entry.classpathEnabled !== undefined || entry.classpathCommand !== undefined) {
        mapped.classpath = {};
        if (entry.classpathEnabled !== undefined) {
          mapped.classpath.enabled = entry.classpathEnabled;
        }
        if (entry.classpathCommand !== undefined) {
          mapped.classpath.cmd = entry.classpathCommand;
        }
      }
      return mapped;
    }),
  };
}

/**
 * The raw settings value with classpath resolution for `path` toggled: the
 * first *valid* entry naming that project (paths compared normalized) gets an
 * explicit `classpathEnabled`, or a minimal entry is appended. Only valid
 * entries can match — `parseProjects` skips invalid ones, so updating an
 * invalid same-path entry would change nothing the server sees. Everything
 * else — invalid entries, unknown keys, the matched entry's other keys — is
 * preserved verbatim, so a toggle never destroys a hand-edit. Never mutates
 * the input.
 */
export function withToggled(
  raw: unknown[],
  path: string,
  enabled: boolean,
): unknown[] {
  return upsertProjectEntry(raw, path, { classpathEnabled: enabled });
}

/**
 * The form's edit to one entry. A key absent from the object is left alone;
 * a key explicitly set to `undefined` is removed from the entry (how the
 * form clears a command override — possible in this settings layer, unlike
 * `.clj-pulse/config.edn` keys, which can only be overridden).
 */
export interface ProjectEntryChanges {
  classpathEnabled?: boolean;
  classpathCommand?: string;
}

/**
 * The raw settings value with `changes` merged into the first *valid* entry
 * naming `path` (paths compared normalized; invalid entries never match —
 * `parseProjects` skips them, so editing one would change nothing the server
 * sees), or a normalized entry appended. Everything else is preserved
 * verbatim. Never mutates the input.
 */
export function upsertProjectEntry(
  raw: unknown[],
  path: string,
  changes: ProjectEntryChanges,
): unknown[] {
  const index = findValidEntryIndex(raw, path);
  if (index === -1) {
    const entry: Record<string, unknown> = { path: normalizeProjectPath(path) };
    applyChanges(entry, changes);
    return [...raw, entry];
  }
  return raw.map((item, i) => {
    if (i !== index) {
      return item;
    }
    const entry = { ...(item as Record<string, unknown>) };
    applyChanges(entry, changes);
    return entry;
  });
}

/**
 * The raw settings value without the first valid entry naming `path`
 * (matching exactly as `upsertProjectEntry` does). For a settings-added
 * project this removes the project; for a detected one it reverts the
 * overrides and the project stays — the server's layering decides, not this
 * function. Always returns a copy; never mutates.
 */
export function removeProjectEntry(raw: unknown[], path: string): unknown[] {
  const index = findValidEntryIndex(raw, path);
  return raw.filter((_, i) => i !== index);
}

/** First entry `parseProjects` would keep for `path`, or -1. */
function findValidEntryIndex(raw: unknown[], path: string): number {
  const target = normalizeProjectPath(path);
  return raw.findIndex(
    (item) =>
      entryProblem(item) === undefined &&
      normalizeProjectPath((item as Record<string, unknown>).path as string) === target,
  );
}

function applyChanges(entry: Record<string, unknown>, changes: ProjectEntryChanges): void {
  if ("classpathEnabled" in changes) {
    if (changes.classpathEnabled === undefined) {
      delete entry.classpathEnabled;
    } else {
      entry.classpathEnabled = changes.classpathEnabled;
    }
  }
  if ("classpathCommand" in changes) {
    if (changes.classpathCommand === undefined) {
      delete entry.classpathCommand;
    } else {
      entry.classpathCommand = changes.classpathCommand;
    }
  }
}

/** The server's default classpath command per project kind; lgx resolves
 *  internally and never runs one. */
export function defaultClasspathCommand(kind: string): string {
  switch (kind) {
    case "lein":
      return "lein classpath";
    case "lgx":
      return "";
    default:
      return "clojure -A:dev:test -Spath";
  }
}

/** What the edit form renders for one project. */
export interface ProjectFormValues {
  path: string;
  classpathEnabled: boolean;
  /** The settings-layer override, or "" — never the inherited value. */
  classpathCommand: string;
  /** The effective command, shown as the field's placeholder: the node's
   *  server-reported cmd, else the per-kind default ("" for lgx). */
  commandPlaceholder: string;
  /** Whether a valid settings entry exists — gates "Remove from settings". */
  hasEntry: boolean;
}

/** The project node slice the edit form needs. */
export interface ProjectNodeInfo {
  path: string;
  kind: string;
  enabled: boolean;
  cmd?: string;
}

/**
 * Pre-fill values for the edit form: effective state from the tree node, the
 * command *override* (only) from the raw settings entry — the effective
 * command appears as the placeholder, so an inherited value is visible but
 * saving without typing never turns it into an explicit override.
 */
export function projectFormValuesFor(
  node: ProjectNodeInfo,
  raw: unknown[],
): ProjectFormValues {
  const index = findValidEntryIndex(raw, node.path);
  const entry =
    index === -1 ? undefined : (raw[index] as Record<string, unknown>);
  return {
    path: node.path,
    classpathEnabled: node.enabled,
    classpathCommand:
      typeof entry?.classpathCommand === "string" ? entry.classpathCommand : "",
    commandPlaceholder: node.cmd ?? defaultClasspathCommand(node.kind),
    hasEntry: entry !== undefined,
  };
}

export type ProjectFormErrors = Partial<Record<"path", string>>;

/**
 * Validation for the form's save. Only the path needs rules, and only in add
 * mode (edit mode's path is read-only, taken from the server): same rules as
 * `parseProjects`, plus no duplicate of an existing project.
 */
export function validateProjectForm(
  values: { path: string },
  existingPaths: string[],
  mode: "add" | "edit",
): ProjectFormErrors {
  if (mode === "edit") {
    return {};
  }
  if (values.path.trim().length === 0) {
    return { path: "Enter a project path, relative to the workspace root" };
  }
  const path = normalizeProjectPath(values.path);
  if (!isWorkspaceRelative(path)) {
    return { path: 'The path must stay inside the workspace (relative, no "..")' };
  }
  if (existingPaths.some((existing) => normalizeProjectPath(existing) === path)) {
    return { path: `"${path}" is already a project` };
  }
  return {};
}

/**
 * Why a raw entry is invalid on its own (duplicates are a list-level rule),
 * or undefined for a valid one. The single validity definition, shared by
 * `parseProjects` (which skips and warns) and `withToggled` (which must match
 * exactly the entries the parser keeps).
 */
function entryProblem(item: unknown): string | undefined {
  if (typeof item !== "object" || item === null || Array.isArray(item)) {
    return "expected an object.";
  }
  const entry = item as Record<string, unknown>;
  if (typeof entry.path !== "string" || entry.path.trim().length === 0) {
    return '"path" is required and must be a non-empty string.';
  }
  if (!isWorkspaceRelative(normalizeProjectPath(entry.path))) {
    return '"path" must stay inside the workspace (relative, no "..").';
  }
  if (entry.classpathEnabled !== undefined && typeof entry.classpathEnabled !== "boolean") {
    return '"classpathEnabled" must be a boolean.';
  }
  if (entry.classpathCommand !== undefined && typeof entry.classpathCommand !== "string") {
    return '"classpathCommand" must be a string.';
  }
  return undefined;
}

/**
 * Whether a normalized path stays inside the workspace: relative, with no
 * `..` components — the same rule the server enforces, checked here so the
 * user gets a warning in the output channel instead of a silently ignored
 * entry. (`"."` is the root and always fine.)
 */
function isWorkspaceRelative(path: string): boolean {
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) {
    return false;
  }
  return !path.split("/").includes("..");
}

/** Identifies an entry in a warning: by path when it has one, else by index. */
function describe(item: unknown, index: number): string {
  if (typeof item === "object" && item !== null && !Array.isArray(item)) {
    const path = (item as Record<string, unknown>).path;
    if (typeof path === "string" && path.trim().length > 0) {
      return `"${path.trim()}"`;
    }
  }
  return `#${index + 1}`;
}
