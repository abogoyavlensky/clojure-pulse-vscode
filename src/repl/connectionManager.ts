import * as fs from "fs";
import * as path from "path";
import { NreplClient, NreplMessage } from "../nrepl/client";
import { Transcript } from "./transcript";

export type ReplState = "disconnected" | "connecting" | "connected";

export interface ReplConnectionInfo {
  host: string;
  port: number;
}

const CONNECT_TIMEOUT_MS = 5000;

/** Thrown when disconnect() is called while a connect is still in flight. */
export class ConnectCancelledError extends Error {
  constructor() {
    super("nREPL connection attempt cancelled");
  }
}

/** Reads the port from `<dir>/.nrepl-port`, as written by nREPL servers. */
export function readNreplPort(dir: string): number | undefined {
  try {
    const text = fs.readFileSync(path.join(dir, ".nrepl-port"), "utf8").trim();
    const port = Number.parseInt(text, 10);
    return Number.isInteger(port) && port > 0 && port <= 65535
      ? port
      : undefined;
  } catch {
    return undefined;
  }
}

interface ActiveConnection {
  info: ReplConnectionInfo;
  client: NreplClient;
  session: string;
}

/**
 * Owns the REPL connections and their lifecycle, and translates nREPL traffic
 * into transcript entries. Shaped as a list with one active connection so a
 * future sidebar managing several connections extends it rather than
 * replacing it.
 */
export class ConnectionManager {
  private connections: ActiveConnection[] = [];
  private currentState: ReplState = "disconnected";
  private stateListeners: Array<(state: ReplState) => void> = [];
  private readonly connectTimeoutMs: number;
  /** Bumped by disconnect() to invalidate an in-flight connect(). */
  private connectAttempt = 0;

  constructor(
    readonly transcript: Transcript,
    options: { connectTimeoutMs?: number } = {},
  ) {
    this.connectTimeoutMs = options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
  }

  get state(): ReplState {
    return this.currentState;
  }

  /** Host/port of the active connection, when connected. */
  get connectionInfo(): ReplConnectionInfo | undefined {
    return this.connections[0]?.info;
  }

  onDidChangeState(listener: (state: ReplState) => void): void {
    this.stateListeners.push(listener);
  }

  async connect(info: ReplConnectionInfo): Promise<void> {
    if (this.currentState !== "disconnected") {
      throw new Error("Already connected to an nREPL server");
    }
    const attempt = ++this.connectAttempt;
    this.setState("connecting");
    let client: NreplClient | undefined;
    try {
      client = await NreplClient.connect(
        info.host,
        info.port,
        this.connectTimeoutMs,
      );
      if (attempt !== this.connectAttempt) {
        throw new ConnectCancelledError();
      }
      // A non-nREPL service can accept TCP and never answer; time the
      // handshake out rather than sticking in "connecting" forever.
      const opened = client;
      const { session, described } = await withTimeout(
        (async () => ({
          session: await opened.clone(),
          described: await opened.describe(),
        }))(),
        this.connectTimeoutMs,
        `nREPL handshake with ${describeInfo(info)} timed out`,
      );
      if (attempt !== this.connectAttempt) {
        throw new ConnectCancelledError();
      }
      const connection: ActiveConnection = { info, client, session };
      this.connections = [connection];

      client.onClose(() => this.onConnectionLost(connection));
      client.onUnhandled((msg) => this.onOutOfBandMessage(connection, msg));

      this.transcript.append({ kind: "banner", text: banner(info, described) });
      this.setState("connected");
    } catch (err) {
      client?.close();
      // A stale (cancelled) attempt must not clobber the state a newer
      // connect may have established since.
      if (attempt === this.connectAttempt) {
        this.connections = [];
        this.setState("disconnected");
      }
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    // Invalidate any in-flight connect() so "Disconnect" during "connecting"
    // cannot be overtaken by the handshake finishing a moment later.
    this.connectAttempt++;
    const connection = this.connections[0];
    if (!connection) {
      this.setState("disconnected");
      return;
    }
    this.connections = [];
    connection.client.close();
    this.transcript.append({
      kind: "info",
      text: `Disconnected from nREPL at ${describeInfo(connection.info)}`,
    });
    this.setState("disconnected");
  }

  /** Evaluates code in the active session, streaming results to the transcript. */
  async eval(code: string): Promise<void> {
    const connection = this.connections[0];
    if (!connection || this.currentState !== "connected") {
      throw new Error("Not connected to an nREPL server");
    }
    this.transcript.append({ kind: "in", text: code });
    await connection.client.eval(code, connection.session, (msg) =>
      this.appendEvalMessage(msg),
    );
  }

  dispose(): void {
    const connection = this.connections[0];
    this.connections = [];
    connection?.client.close();
  }

  private appendEvalMessage(msg: NreplMessage): void {
    if (typeof msg.out === "string") {
      this.transcript.append({ kind: "out", text: msg.out });
    }
    if (typeof msg.err === "string") {
      this.transcript.append({ kind: "err", text: msg.err });
    }
    if (typeof msg.value === "string") {
      this.transcript.append({ kind: "value", text: msg.value });
    }
  }

  /** Out-of-band messages (no pending request id) for our session, e.g.
   *  output from a future started by an earlier eval. */
  private onOutOfBandMessage(
    connection: ActiveConnection,
    msg: NreplMessage,
  ): void {
    if (this.connections[0] === connection && msg.session === connection.session) {
      this.appendEvalMessage(msg);
    }
  }

  private onConnectionLost(connection: ActiveConnection): void {
    if (this.connections[0] !== connection) {
      return; // already disconnected deliberately
    }
    this.connections = [];
    this.transcript.append({
      kind: "info",
      text: `Connection lost to nREPL at ${describeInfo(connection.info)}`,
    });
    this.setState("disconnected");
  }

  private setState(state: ReplState): void {
    if (this.currentState === state) {
      return;
    }
    this.currentState = state;
    for (const listener of this.stateListeners) {
      listener(state);
    }
  }
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

function describeInfo(info: ReplConnectionInfo): string {
  return `${info.host}:${info.port}`;
}

function banner(info: ReplConnectionInfo, described: NreplMessage): string {
  const parts = [`Connected to nREPL at ${describeInfo(info)}`];
  const versions = (described.versions ?? {}) as Record<
    string,
    { "version-string"?: unknown } | undefined
  >;
  const nrepl = versions.nrepl?.["version-string"];
  const clojure = versions.clojure?.["version-string"];
  if (typeof nrepl === "string") {
    parts.push(`nREPL ${nrepl}`);
  }
  if (typeof clojure === "string") {
    parts.push(`Clojure ${clojure}`);
  }
  return parts.join(" · ");
}
