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
  const target = normalizeProjectPath(path);
  const index = raw.findIndex(
    (item) =>
      entryProblem(item) === undefined &&
      normalizeProjectPath((item as Record<string, unknown>).path as string) === target,
  );
  if (index === -1) {
    return [...raw, { path: target, classpathEnabled: enabled }];
  }
  return raw.map((item, i) =>
    i === index
      ? { ...(item as Record<string, unknown>), classpathEnabled: enabled }
      : item,
  );
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
