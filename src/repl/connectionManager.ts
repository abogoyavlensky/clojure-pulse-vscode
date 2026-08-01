import {
  EvalExtras,
  LoadFileExtras,
  NreplClient,
  NreplMessage,
} from "../nrepl/client";
import { AnsiStripper } from "./ansi";
import { Transcript } from "./transcript";

export type ReplState = "disconnected" | "connecting" | "connected";

export interface ReplConnectionInfo {
  host: string;
  port: number;
}

/** Source-location params carried through to the nREPL `eval` op. */
export type EvalOptions = EvalExtras;

/** Path params carried through to the nREPL `load-file` op. */
export type LoadFileOptions = LoadFileExtras;

/**
 * The distilled result of one evaluation, for callers that show it (e.g.
 * inline decorations). The transcript still receives every streamed message
 * regardless; this is additive.
 */
export interface EvalOutcome {
  /** The last `value` the server sent, if any. */
  value?: string;
  /** All `err` chunks concatenated in arrival order, if any. */
  err?: string;
  /** True when any message's status reported `namespace-not-found`. */
  namespaceNotFound: boolean;
}

const CONNECT_TIMEOUT_MS = 5000;

/** Thrown when disconnect() is called while a connect is still in flight. */
export class ConnectCancelledError extends Error {
  constructor() {
    super("nREPL connection attempt cancelled");
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
  // `out` and `err` are distinct streams, and an escape sequence can be split
  // across a stream's messages — each needs its own stripper.
  private outAnsi = new AnsiStripper();
  private errAnsi = new AnsiStripper();

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
    // A held-back escape fragment must not survive into a new connection.
    this.outAnsi = new AnsiStripper();
    this.errAnsi = new AnsiStripper();
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
      if (attempt !== this.connectAttempt) {
        // The user cancelled while this attempt was still failing: report
        // the cancellation, not the stale underlying error — and leave the
        // state alone in case a newer connect has established since.
        throw new ConnectCancelledError();
      }
      this.connections = [];
      this.setState("disconnected");
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

  /** Evaluates code in the active session, streaming results to the
   *  transcript and resolving with the distilled outcome. */
  async eval(code: string, opts?: EvalOptions): Promise<EvalOutcome> {
    const connection = this.requireConnection();
    this.transcript.append({ kind: "in", text: code });
    const outcome = newOutcome();
    await connection.client.eval(
      code,
      connection.session,
      (msg) => this.collectEvalMessage(msg, outcome),
      opts,
    );
    return outcome;
  }

  /** Loads the whole buffer via `load-file`, streaming results to the
   *  transcript and resolving with the distilled outcome. */
  async loadFile(content: string, opts?: LoadFileOptions): Promise<EvalOutcome> {
    const connection = this.requireConnection();
    this.transcript.append({
      kind: "info",
      text: `Loading ${opts?.fileName ?? "buffer"}…`,
    });
    const outcome = newOutcome();
    await connection.client.loadFile(
      content,
      connection.session,
      (msg) => this.collectEvalMessage(msg, outcome),
      opts,
    );
    return outcome;
  }

  private requireConnection(): ActiveConnection {
    const connection = this.connections[0];
    if (!connection || this.currentState !== "connected") {
      throw new Error("Not connected to an nREPL server");
    }
    return connection;
  }

  dispose(): void {
    const connection = this.connections[0];
    this.connections = [];
    connection?.client.close();
  }

  /**
   * `msg` with ANSI escape codes stripped out of `out`/`err`. Called exactly
   * once per incoming message — the strippers are stateful, and a chunk that
   * was entirely a held-back fragment comes back as an empty string, which
   * every consumer treats as nothing to report.
   */
  private sanitizeMessage(msg: NreplMessage): NreplMessage {
    if (typeof msg.out !== "string" && typeof msg.err !== "string") {
      return msg;
    }
    const clean = { ...msg };
    if (typeof msg.out === "string") {
      clean.out = this.outAnsi.strip(msg.out);
    }
    if (typeof msg.err === "string") {
      clean.err = this.errAnsi.strip(msg.err);
    }
    return clean;
  }

  private appendEvalMessage(msg: NreplMessage): void {
    if (typeof msg.out === "string" && msg.out.length > 0) {
      this.transcript.append({ kind: "out", text: msg.out });
    }
    if (typeof msg.err === "string" && msg.err.length > 0) {
      this.transcript.append({ kind: "err", text: msg.err });
    }
    if (typeof msg.value === "string") {
      this.transcript.append({ kind: "value", text: msg.value });
    }
  }

  /** Streams a message to the transcript and accumulates it into `outcome`. */
  private collectEvalMessage(msg: NreplMessage, outcome: EvalOutcome): void {
    const clean = this.sanitizeMessage(msg);
    this.appendEvalMessage(clean);
    if (typeof clean.value === "string") {
      outcome.value = clean.value;
    }
    if (typeof clean.err === "string" && clean.err.length > 0) {
      outcome.err = (outcome.err ?? "") + clean.err;
    }
    if (Array.isArray(clean.status) && clean.status.includes("namespace-not-found")) {
      outcome.namespaceNotFound = true;
    }
  }

  /** Out-of-band messages (no pending request id) for our session, e.g.
   *  output from a future started by an earlier eval. */
  private onOutOfBandMessage(
    connection: ActiveConnection,
    msg: NreplMessage,
  ): void {
    if (this.connections[0] === connection && msg.session === connection.session) {
      this.appendEvalMessage(this.sanitizeMessage(msg));
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

function newOutcome(): EvalOutcome {
  return { namespaceNotFound: false };
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
