/**
 * One configured REPL, from its settings entry to a live connection.
 *
 * A session composes the pieces that already exist — a `Transcript` rendered
 * into an output channel, a `ConnectionManager` for the nREPL socket, and (for
 * `create` configs) a `ReplProcess` running the server — and adds the state
 * machine that ties them together:
 *
 *     stopped → starting (create only) → connecting → connected
 *
 * **Invariant: entering `stopped` always kills an owned process.** Every
 * failure path funnels through `beginStop()`, so a `create` session can never
 * report `stopped` while the server it spawned is still running.
 */

import * as path from "path";
import {
  ConnectionManager,
  EvalOptions,
  EvalOutcome,
  LoadFileOptions,
  ReplConnectionInfo,
} from "./connectionManager";
import { attachTranscriptRenderer, OutputSink } from "./outputRenderer";
import {
  ReplConfig,
  resolvePortFilePath,
  resolvePortSync,
} from "./replConfig";
import { ReplProcess, ReplProcessLike, ReplProcessOptions } from "./replProcess";
import { Transcript } from "./transcript";

export type ReplSessionState = "stopped" | "starting" | "connecting" | "connected";

/** The output-channel surface a session needs; `vscode.OutputChannel` fits. */
export interface ReplChannel extends OutputSink {
  show(): void;
  dispose(): void;
}

export interface ReplSessionDeps {
  /** Absolute path used to resolve relative `cwd` and port-file settings. */
  workspaceRoot?: string;
  /** Channels are owned (and memoized by name) by the registry. */
  createChannel: (name: string) => ReplChannel;
  createProcess?: (options: ReplProcessOptions) => ReplProcessLike;
  /** Overridden in tests to keep failing handshakes quick. */
  connectTimeoutMs?: number;
}

export class ReplSession {
  readonly transcript = new Transcript();
  private readonly manager: ConnectionManager;
  private currentState: ReplSessionState = "stopped";
  private stateListeners: Array<(state: ReplSessionState) => void> = [];
  private process: ReplProcessLike | undefined;
  private channel: ReplChannel | undefined;
  /** Bumped by every stop, so a startup still waiting on a port cannot come
   *  back and connect after the session was told to stop. */
  private startAttempt = 0;
  /** The in-flight shutdown, shared by everything that asks to stop. */
  private stopping: Promise<void> | undefined;

  constructor(
    readonly config: ReplConfig,
    private readonly deps: ReplSessionDeps,
  ) {
    this.manager = new ConnectionManager(
      this.transcript,
      deps.connectTimeoutMs === undefined
        ? {}
        : { connectTimeoutMs: deps.connectTimeoutMs },
    );
    // A connection that drops on its own (server died, socket closed) ends the
    // session — and takes an owned process with it.
    this.manager.onDidChangeState((state) => {
      if (state === "disconnected" && this.currentState !== "stopped") {
        void this.enterStopped();
      }
    });
  }

  get name(): string {
    return this.config.name;
  }

  get state(): ReplSessionState {
    return this.currentState;
  }

  get connectionInfo(): ReplConnectionInfo | undefined {
    return this.currentState === "connected" ? this.manager.connectionInfo : undefined;
  }

  onDidChangeState(listener: (state: ReplSessionState) => void): void {
    this.stateListeners.push(listener);
  }

  /** Brings the session up: spawn then connect for `create`, connect for
   *  `connect`. Rejects with the reason, which is also written to the channel. */
  async start(): Promise<void> {
    if (this.currentState !== "stopped") {
      return;
    }
    const attempt = ++this.startAttempt;
    this.ensureChannel();
    try {
      const port =
        this.config.type === "create"
          ? await this.startProcess(this.config.command, this.config.cwd)
          : this.resolveConfiguredPort();
      // A stop while the server was still coming up wins: connecting now
      // would resurrect a session the user just shut down.
      if (this.isStale(attempt)) {
        return;
      }
      const host = this.config.type === "connect" ? this.config.host : "127.0.0.1";
      this.setState("connecting");
      await this.manager.connect({ host, port });
      if (this.isStale(attempt)) {
        await this.manager.disconnect();
        return;
      }
      this.setState("connected");
    } catch (err: unknown) {
      // A failure caused by our own stop (the kill ends the port wait) is not
      // something to report.
      if (this.isStale(attempt)) {
        return;
      }
      const reason = err instanceof Error ? err.message : String(err);
      this.transcript.append({ kind: "info", text: reason });
      await this.enterStopped();
      throw err;
    }
  }

  /** Disconnects and kills an owned process; resolves once it is really gone. */
  async stop(): Promise<void> {
    this.startAttempt++;
    await this.manager.disconnect();
    await this.enterStopped();
  }

  async eval(code: string, opts?: EvalOptions): Promise<EvalOutcome> {
    return this.manager.eval(code, opts);
  }

  async loadFile(content: string, opts?: LoadFileOptions): Promise<EvalOutcome> {
    return this.manager.loadFile(content, opts);
  }

  /** Reveals this session's channel, creating it if it has never run. */
  showOutput(): void {
    this.ensureChannel().show();
  }

  /** Stops everything this session owns. The channel belongs to the registry
   *  and outlives the session, so it is not disposed here. */
  async dispose(): Promise<void> {
    this.startAttempt++;
    this.manager.dispose();
    await this.enterStopped();
  }

  /** Spawns the server and waits for it to report its port. */
  private async startProcess(command: string, cwd: string): Promise<number> {
    const options: ReplProcessOptions = { command, cwd: this.resolveCwd(cwd) };
    const proc = (this.deps.createProcess ?? ((o) => new ReplProcess(o)))(options);
    this.process = proc;
    proc.onOutput((text) => this.transcript.append({ kind: "out", text }));
    proc.onExit(({ code, signal }) =>
      this.transcript.append({
        kind: "info",
        text: signal
          ? `nREPL process terminated (${signal})`
          : `nREPL process exited with code ${code ?? "unknown"}`,
      }),
    );
    this.transcript.append({ kind: "info", text: `Running: ${command}` });
    this.setState("starting");
    proc.start();
    return proc.waitForPort();
  }

  /** The port a `connect` config points at — a number, or one read from the
   *  configured port file. */
  private resolveConfiguredPort(): number {
    if (this.config.type !== "connect") {
      throw new Error("Not a connect configuration");
    }
    const port = resolvePortSync(this.config.port, this.deps.workspaceRoot);
    if (port !== undefined) {
      return port;
    }
    const file = resolvePortFilePath(this.config.port, this.deps.workspaceRoot);
    throw new Error(
      file
        ? `Could not read an nREPL port from ${file}`
        : `Could not resolve the nREPL port "${String(this.config.port)}" — open a workspace folder or use an absolute path`,
    );
  }

  private resolveCwd(cwd: string): string {
    if (path.isAbsolute(cwd)) {
      return cwd;
    }
    return path.resolve(this.deps.workspaceRoot ?? process.cwd(), cwd);
  }

  /**
   * Enters `stopped`, killing an owned process on the way out. `stopped` is
   * published only once that kill has finished, so nothing downstream can
   * restart or replace the session while its old server is still alive.
   * Concurrent callers (explicit stop, a dropped connection, dispose) share
   * one shutdown.
   */
  private enterStopped(): Promise<void> {
    if (this.stopping) {
      return this.stopping;
    }
    // Startups are invalidated by stop()/dispose() only: a stop triggered by
    // a *failing* attempt must leave that attempt free to report its error.
    const proc = this.process;
    this.process = undefined;
    if (!proc) {
      this.setState("stopped");
      return Promise.resolve();
    }
    this.stopping = proc
      .stop()
      .catch(() => {})
      .then(() => {
        this.setState("stopped");
      })
      .finally(() => {
        this.stopping = undefined;
      });
    return this.stopping;
  }

  private isStale(attempt: number): boolean {
    return attempt !== this.startAttempt;
  }

  private ensureChannel(): ReplChannel {
    if (!this.channel) {
      this.channel = this.deps.createChannel(this.name);
      attachTranscriptRenderer(this.transcript, this.channel);
    }
    return this.channel;
  }

  private setState(state: ReplSessionState): void {
    if (this.currentState === state) {
      return;
    }
    this.currentState = state;
    for (const listener of this.stateListeners) {
      listener(state);
    }
  }
}
