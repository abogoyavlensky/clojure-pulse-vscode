import * as fs from "fs";
import * as path from "path";

/** Raw `clojurePulse.server.*` configuration. */
export interface ServerConfig {
  path: string;
  args: string[];
}

/** A successfully resolved server invocation. */
export interface ResolvedServer {
  command: string;
  args: string[];
}

/** A resolution failure carrying a user-facing message. */
export interface ServerResolutionError {
  error: string;
}

export type ServerResolution = ResolvedServer | ServerResolutionError;

export function isError(r: ServerResolution): r is ServerResolutionError {
  return (r as ServerResolutionError).error !== undefined;
}

const DEFAULT_COMMAND = "clj-pulse";

/**
 * Resolves the `clj-pulse` server command from configuration.
 *
 * - An explicit path (one containing a path separator) is trusted and returned
 *   verbatim — the user knows where their binary lives.
 * - A bare command name is searched across the `PATH` entries in `env`; the
 *   first executable match wins. If none is found, a structured error is
 *   returned so the caller can guide the user instead of crashing.
 */
export function resolveServerPath(
  config: ServerConfig,
  env: NodeJS.ProcessEnv = process.env,
): ServerResolution {
  const command = config.path?.trim() || DEFAULT_COMMAND;
  const args = config.args ?? [];

  if (command.includes("/") || command.includes(path.sep)) {
    return { command, args };
  }

  const resolved = findOnPath(command, env);
  if (resolved) {
    return { command: resolved, args };
  }

  return {
    error:
      `'${command}' was not found on your PATH. Install clj-pulse, or set ` +
      `"clojurePulse.server.path" to the full path of the binary.`,
  };
}

function findOnPath(command: string, env: NodeJS.ProcessEnv): string | undefined {
  const pathVar = env.PATH ?? env.Path ?? "";
  if (!pathVar) {
    return undefined;
  }

  // Probe the command exactly as given first — this covers an explicit
  // ".exe"/".cmd" on Windows — then fall back to the PATHEXT variants for a
  // bare name. On POSIX the only candidate is the command itself.
  const extensions =
    process.platform === "win32"
      ? ["", ...(env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";")]
      : [""];

  for (const dir of pathVar.split(path.delimiter)) {
    if (!dir) {
      continue;
    }
    for (const ext of extensions) {
      const candidate = path.join(dir, command + ext);
      if (isExecutableFile(candidate)) {
        return candidate;
      }
    }
  }

  return undefined;
}

function isExecutableFile(candidate: string): boolean {
  try {
    if (!fs.statSync(candidate).isFile()) {
      return false;
    }
    if (process.platform === "win32") {
      return true;
    }
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
