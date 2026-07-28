/**
 * Runs an nREPL server as a child process and reports the port it came up on.
 *
 * The command is a plain string run through the shell — what the REPL manager
 * shows is literally what runs. There is deliberately **no startup timeout**:
 * a first run can spend minutes downloading dependencies, and the session's
 * output channel shows that progress while Stop stays available.
 *
 * Pure Node (no `vscode` import) so it is testable against real short-lived
 * shell commands.
 */

import { ChildProcess, spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { readPortFile } from "./replConfig";

const PORT_LINE = /nREPL server started on port (\d+)/;
/** How often the `.nrepl-port` fallback is re-checked while starting. */
const PORT_FILE_POLL_MS = 2000;
/** Grace between SIGTERM and SIGKILL when stopping a process group. */
const KILL_GRACE_MS = 2000;
/** Cap on retained stdout while hunting for the port line. */
const PORT_SCAN_BUFFER = 8192;

export interface ProcessExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface ReplProcessOptions {
  /** Verbatim command line, run through the shell. */
  command: string;
  /** Absolute working directory for the process. */
  cwd: string;
  /** Poll interval for the `.nrepl-port` fallback (tests shorten it). */
  portFilePollMs?: number;
}

/** The slice of `ReplProcess` a session depends on, so tests can fake it. */
export interface ReplProcessLike {
  start(): void;
  waitForPort(): Promise<number>;
  onOutput(listener: (text: string) => void): void;
  onExit(listener: (exit: ProcessExit) => void): void;
  stop(): Promise<void>;
}

/** Reads the port out of nREPL's startup line, if it is in `text` yet. */
export function parseNreplPort(text: string): number | undefined {
  const match = PORT_LINE.exec(text);
  if (!match) {
    return undefined;
  }
  const port = Number.parseInt(match[1], 10);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : undefined;
}

export class ReplProcess implements ReplProcessLike {
  private child: ChildProcess | undefined;
  private outputListeners: Array<(text: string) => void> = [];
  private exitListeners: Array<(exit: ProcessExit) => void> = [];
  /** Accumulated (and capped) stdout, scanned for the port line. */
  private scanBuffer = "";
  private startedAt = 0;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private settled = false;
  private stopped = false;
  private resolvePort!: (port: number) => void;
  private rejectPort!: (err: Error) => void;
  private readonly portPromise: Promise<number>;

  constructor(private readonly options: ReplProcessOptions) {
    this.portPromise = new Promise<number>((resolve, reject) => {
      this.resolvePort = resolve;
      this.rejectPort = reject;
    });
    // Nothing may await this promise before waitForPort() is called (e.g. a
    // session that never gets that far), and an unhandled rejection would tear
    // down the extension host.
    this.portPromise.catch(() => {});
  }

  /** Pid of the shell leading the process group, once started. */
  get pid(): number | undefined {
    return this.child?.pid;
  }

  start(): void {
    if (this.child || this.stopped) {
      return;
    }
    this.startedAt = Date.now();
    // `detached` puts the shell and everything it spawns (the `clojure`
    // wrapper, then java) in one process group we can kill as a unit.
    const child = spawn(this.options.command, {
      shell: true,
      cwd: this.options.cwd,
      detached: process.platform !== "win32",
    });
    this.child = child;

    child.stdout?.on("data", (chunk: Buffer) => this.onData(chunk.toString()));
    child.stderr?.on("data", (chunk: Buffer) => this.onData(chunk.toString()));
    child.on("error", (err) => {
      this.emitOutput(`${err.message}\n`);
      this.fail(new Error(`Failed to start nREPL process: ${err.message}`));
    });
    child.on("exit", (code, signal) => {
      this.stopPolling();
      this.fail(
        new Error(
          signal
            ? `nREPL process exited on ${signal} before reporting a port`
            : `nREPL process exited with code ${code ?? "unknown"} before reporting a port`,
        ),
      );
      for (const listener of this.exitListeners) {
        listener({ code, signal });
      }
    });

    this.pollTimer = setInterval(
      () => this.checkPortFile(),
      this.options.portFilePollMs ?? PORT_FILE_POLL_MS,
    );
  }

  /** Resolves with the discovered port; rejects if the process ends first. */
  waitForPort(): Promise<number> {
    return this.portPromise;
  }

  onOutput(listener: (text: string) => void): void {
    this.outputListeners.push(listener);
  }

  onExit(listener: (exit: ProcessExit) => void): void {
    this.exitListeners.push(listener);
  }

  /** Kills the whole process group and resolves once it is gone. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.stopPolling();
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      return;
    }
    const done = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    killGroup(child, "SIGTERM");
    await Promise.race([done, delay(KILL_GRACE_MS)]);
    if (child.exitCode === null && child.signalCode === null) {
      killGroup(child, "SIGKILL");
      await Promise.race([done, delay(KILL_GRACE_MS)]);
    }
  }

  private onData(text: string): void {
    this.emitOutput(text);
    if (this.settled) {
      return;
    }
    this.scanBuffer = (this.scanBuffer + text).slice(-PORT_SCAN_BUFFER);
    const port = parseNreplPort(this.scanBuffer);
    if (port !== undefined) {
      this.succeed(port);
      return;
    }
    // A server can write `.nrepl-port` around its last output line, so check
    // the file on every chunk as well as on the poll timer.
    this.checkPortFile();
  }

  /**
   * Accepts `.nrepl-port` in the working directory only when it was written
   * after this process started — a leftover file from a previous run would
   * otherwise point the session at a server that is already gone.
   */
  private checkPortFile(): void {
    if (this.settled) {
      return;
    }
    const file = path.join(this.options.cwd, ".nrepl-port");
    let mtimeMs: number;
    try {
      mtimeMs = fs.statSync(file).mtimeMs;
    } catch {
      return;
    }
    if (mtimeMs < this.startedAt) {
      return;
    }
    const port = readPortFile(file);
    if (port !== undefined) {
      this.succeed(port);
    }
  }

  private emitOutput(text: string): void {
    for (const listener of this.outputListeners) {
      listener(text);
    }
  }

  private succeed(port: number): void {
    this.settled = true;
    this.scanBuffer = "";
    this.stopPolling();
    this.resolvePort(port);
  }

  private fail(err: Error): void {
    if (this.settled) {
      return;
    }
    this.settled = true;
    this.rejectPort(err);
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }
}

/** Signals the whole group on POSIX; on Windows, kills the tree via taskkill. */
function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid === undefined) {
    return;
  }
  try {
    if (process.platform === "win32") {
      // Windows has no process groups to signal; taskkill /T ends the tree.
      spawn("taskkill", ["/PID", String(pid), "/T", "/F"]);
    } else {
      process.kill(-pid, signal);
    }
  } catch {
    // Already gone (ESRCH), or the group leader vanished mid-kill.
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
