/**
 * The REPL manager's configuration model: what `clojurePulse.replConfigurations`
 * may contain, how a raw settings value is validated into it, and how a
 * configured port resolves to a number. Pure (no `vscode` import) so the
 * settings value is passed in and every rule here is unit-testable.
 */

import * as fs from "fs";
import * as path from "path";

/** Spawns an nREPL server from a command line, then connects to it. */
export interface CreateReplConfig {
  name: string;
  type: "create";
  /** Verbatim command line, run through the shell. */
  command: string;
  /** Workspace-relative (or absolute) working directory; `"."` by default. */
  cwd: string;
}

/** Attaches to an already-running nREPL server. */
export interface ConnectReplConfig {
  name: string;
  type: "connect";
  host: string;
  /** A port number, or a path to a file holding one (e.g. `".nrepl-port"`). */
  port: number | string;
}

export type ReplConfig = CreateReplConfig | ConnectReplConfig;

export interface ParsedReplConfigurations {
  configs: ReplConfig[];
  /** One message per skipped entry, for the extension's log channel. */
  warnings: string[];
}

const MIN_PORT = 1;
const MAX_PORT = 65535;

/** The nREPL version injected by the default create command. */
const NREPL_VERSION = "1.7.0";

/**
 * Validates the raw `clojurePulse.replConfigurations` value. Invalid entries
 * are skipped with a warning rather than failing the whole list, so one bad
 * hand-edit never empties the tree.
 */
export function parseReplConfigurations(raw: unknown): ParsedReplConfigurations {
  if (raw === undefined || raw === null) {
    return { configs: [], warnings: [] };
  }
  if (!Array.isArray(raw)) {
    return {
      configs: [],
      warnings: ["clojurePulse.replConfigurations must be an array."],
    };
  }

  const configs: ReplConfig[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();

  raw.forEach((item, index) => {
    const skip = (reason: string): void => {
      warnings.push(`Skipped REPL configuration ${describe(item, index)}: ${reason}`);
    };

    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      skip("expected an object.");
      return;
    }
    const entry = item as Record<string, unknown>;

    const name = typeof entry.name === "string" ? entry.name.trim() : "";
    if (name.length === 0) {
      skip('"name" is required and must be a non-empty string.');
      return;
    }
    if (seen.has(name)) {
      skip(`duplicate name "${name}".`);
      return;
    }

    if (entry.type === "create") {
      const command = typeof entry.command === "string" ? entry.command.trim() : "";
      if (command.length === 0) {
        skip('"command" is required for type "create".');
        return;
      }
      const cwd =
        typeof entry.cwd === "string" && entry.cwd.trim().length > 0
          ? entry.cwd.trim()
          : ".";
      seen.add(name);
      configs.push({ name, type: "create", command, cwd });
      return;
    }

    if (entry.type === "connect") {
      const port = validatePort(entry.port);
      if (port === undefined) {
        skip(
          '"port" is required for type "connect" and must be a port number (1-65535) or a path to a port file.',
        );
        return;
      }
      const host =
        typeof entry.host === "string" && entry.host.trim().length > 0
          ? entry.host.trim()
          : "localhost";
      seen.add(name);
      configs.push({ name, type: "connect", host, port });
      return;
    }

    skip('"type" must be "create" or "connect".');
  });

  return { configs, warnings };
}

/**
 * The name a raw settings entry contributes, normalized exactly as
 * `parseReplConfigurations` does — so a command editing the raw array matches
 * the same entries the tree is showing.
 */
export function configEntryName(entry: unknown): string | undefined {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    return undefined;
  }
  const name = (entry as Record<string, unknown>).name;
  if (typeof name !== "string") {
    return undefined;
  }
  const trimmed = name.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Validates what the user typed for a `connect` port: a number must be a
 * usable port, anything else is taken as a port-file path. Returns the
 * complaint to show, or undefined when the input is fine.
 */
export function validatePortInput(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return "Enter a port number or a path to a port file";
  }
  if (/^\d+$/.test(trimmed) && !isPort(Number.parseInt(trimmed, 10))) {
    return `Enter a port number between ${MIN_PORT} and ${MAX_PORT}`;
  }
  return undefined;
}

/** A numeric port in range, or a non-empty port-file path; else undefined. */
function validatePort(value: unknown): number | string | undefined {
  if (typeof value === "number") {
    return isPort(value) ? value : undefined;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  return undefined;
}

function isPort(value: number): boolean {
  return Number.isInteger(value) && value >= MIN_PORT && value <= MAX_PORT;
}

/** Identifies an entry in a warning: by name when it has one, else by index. */
function describe(item: unknown, index: number): string {
  if (typeof item === "object" && item !== null && !Array.isArray(item)) {
    const name = (item as Record<string, unknown>).name;
    if (typeof name === "string" && name.trim().length > 0) {
      return `"${name.trim()}"`;
    }
  }
  return `#${index + 1}`;
}

/**
 * The command the add-config flow prefills. It injects nREPL under our own
 * namespaced alias rather than as a bare `:deps` override, so adding project
 * aliases composes: `-M:dev:test:clojure-pulse/nrepl` merges every alias's
 * `:extra-deps`, and `:main-opts` is last-alias-wins, so nREPL still starts.
 */
export function defaultCreateCommand(
  platform: NodeJS.Platform = process.platform,
): string {
  const deps = `{:aliases {:clojure-pulse/nrepl {:extra-deps {nrepl/nrepl {:mvn/version "${NREPL_VERSION}"}} :main-opts ["-m" "nrepl.cmdline"]}}}`;
  // No `--interactive`: the extension owns the process, and the bare server
  // prints its port line and blocks.
  const quoted =
    platform === "win32" ? `"${deps.replace(/"/g, '\\"')}"` : `'${deps}'`;
  return `clojure -Sdeps ${quoted} -M:clojure-pulse/nrepl`;
}

/**
 * Reads a port from a file holding just the number, as nREPL writes it. The
 * contents must be digits only — `parseInt` would happily read `7888abc` as
 * 7888 and connect somewhere the file never named.
 */
export function readPortFile(filePath: string): number | undefined {
  try {
    const text = fs.readFileSync(filePath, "utf8").trim();
    if (!/^\d+$/.test(text)) {
      return undefined;
    }
    const port = Number.parseInt(text, 10);
    return isPort(port) ? port : undefined;
  } catch {
    return undefined;
  }
}

/** Reads the port from `<dir>/.nrepl-port`, as written by nREPL servers. */
export function readNreplPort(dir: string): number | undefined {
  return readPortFile(path.join(dir, ".nrepl-port"));
}

/**
 * The file a string port points at: absolute paths as-is, relative ones
 * against the workspace root. Undefined for numeric ports (nothing to read)
 * and for a relative path with no workspace open — callers use it to name the
 * file they failed to read.
 */
export function resolvePortFilePath(
  port: number | string,
  workspaceRoot: string | undefined,
): string | undefined {
  if (typeof port === "number") {
    return undefined;
  }
  if (path.isAbsolute(port)) {
    return port;
  }
  return workspaceRoot ? path.join(workspaceRoot, port) : undefined;
}

/** Resolves a configured port to a number: passthrough, or a port-file read. */
export function resolvePortSync(
  port: number | string,
  workspaceRoot: string | undefined,
): number | undefined {
  if (typeof port === "number") {
    return isPort(port) ? port : undefined;
  }
  const filePath = resolvePortFilePath(port, workspaceRoot);
  return filePath ? readPortFile(filePath) : undefined;
}
