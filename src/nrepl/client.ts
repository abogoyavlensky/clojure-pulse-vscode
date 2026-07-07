import * as net from "net";
import { encode, decodeBuffer, BencodeValue } from "./bencode";

/** A decoded nREPL response message. */
export type NreplMessage = Record<string, unknown>;

export type NreplRequest = Record<string, BencodeValue | undefined> & {
  op: string;
};

/** Source-location params for `eval` (all optional). */
export interface EvalExtras {
  ns?: string;
  file?: string;
  /** 1-based. */
  line?: number;
  /** 1-based. */
  column?: number;
}

/** Path params for `load-file` (all optional; untitled buffers send none). */
export interface LoadFileExtras {
  filePath?: string;
  fileName?: string;
}

interface PendingRequest {
  messages: NreplMessage[];
  onMessage?: (msg: NreplMessage) => void;
  resolve: (messages: NreplMessage[]) => void;
  reject: (err: Error) => void;
}

/**
 * Persistent nREPL connection: one socket, many in-flight requests. Every
 * outgoing message carries a unique `id`; responses are routed back to their
 * request until one arrives with `status` containing "done". Messages with no
 * matching id (e.g. `out` printed by other sessions) go to `onUnhandled`.
 */
export class NreplClient {
  private nextId = 1;
  private readonly pending = new Map<string, PendingRequest>();
  private buffer: Buffer = Buffer.alloc(0);
  private closed = false;
  private closeListeners: Array<() => void> = [];
  private unhandledListeners: Array<(msg: NreplMessage) => void> = [];

  private constructor(private readonly socket: net.Socket) {
    socket.on("data", (data) => this.onData(data));
    socket.on("error", () => this.onSocketClosed());
    socket.on("close", () => this.onSocketClosed());
  }

  static connect(
    host: string,
    port: number,
    timeoutMs: number,
  ): Promise<NreplClient> {
    return new Promise((resolve, reject) => {
      const socket = net.connect({ host, port });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`Connection to ${host}:${port} timed out`));
      }, timeoutMs);
      socket.once("connect", () => {
        clearTimeout(timer);
        socket.setNoDelay(true);
        resolve(new NreplClient(socket));
      });
      socket.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  /** Sends a request and resolves with all its messages once "done" arrives. */
  send(
    request: NreplRequest,
    onMessage?: (msg: NreplMessage) => void,
  ): Promise<NreplMessage[]> {
    if (this.closed) {
      return Promise.reject(new Error("nREPL connection is closed"));
    }
    const id = String(this.nextId++);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { messages: [], onMessage, resolve, reject });
      this.socket.write(encode({ ...request, id }));
    });
  }

  async clone(): Promise<string> {
    const messages = await this.send({ op: "clone" });
    const session = messages.find((m) => m["new-session"])?.["new-session"];
    if (typeof session !== "string") {
      throw new Error("nREPL clone returned no session id");
    }
    return session;
  }

  async describe(): Promise<NreplMessage> {
    const messages = await this.send({ op: "describe" });
    return messages[messages.length - 1] ?? {};
  }

  eval(
    code: string,
    session: string,
    onMessage?: (msg: NreplMessage) => void,
    extra?: EvalExtras,
  ): Promise<NreplMessage[]> {
    // send() drops keys whose value is undefined, so absent extras never
    // reach the wire.
    return this.send(
      {
        op: "eval",
        code,
        session,
        ns: extra?.ns,
        file: extra?.file,
        line: extra?.line,
        column: extra?.column,
      },
      onMessage,
    );
  }

  /** Sends the whole buffer via the `load-file` op, so the server compiles
   *  it as a unit (the buffer's own `ns` form applies, stack traces get real
   *  file/line locations). */
  loadFile(
    file: string,
    session: string,
    onMessage?: (msg: NreplMessage) => void,
    extra?: LoadFileExtras,
  ): Promise<NreplMessage[]> {
    return this.send(
      {
        op: "load-file",
        file,
        session,
        "file-path": extra?.filePath,
        "file-name": extra?.fileName,
      },
      onMessage,
    );
  }

  onClose(listener: () => void): void {
    this.closeListeners.push(listener);
  }

  onUnhandled(listener: (msg: NreplMessage) => void): void {
    this.unhandledListeners.push(listener);
  }

  close(): void {
    this.closed = true;
    this.socket.destroy();
  }

  private onData(data: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, data]);
    let decoded: BencodeValue[];
    try {
      const result = decodeBuffer(this.buffer);
      decoded = result.decoded;
      this.buffer = result.rest;
    } catch {
      // Corrupt bencode: the stream cannot recover — drop the connection.
      this.close();
      return;
    }
    for (const raw of decoded) {
      this.dispatch(raw as NreplMessage);
    }
  }

  private dispatch(msg: NreplMessage): void {
    const id = typeof msg.id === "string" ? msg.id : undefined;
    const request = id === undefined ? undefined : this.pending.get(id);
    if (id === undefined || !request) {
      for (const listener of this.unhandledListeners) {
        listener(msg);
      }
      return;
    }
    request.messages.push(msg);
    request.onMessage?.(msg);
    if (Array.isArray(msg.status) && msg.status.includes("done")) {
      this.pending.delete(id);
      request.resolve(request.messages);
    }
  }

  private onSocketClosed(): void {
    if (this.closed && this.pending.size === 0) {
      return;
    }
    this.closed = true;
    const error = new Error("nREPL connection closed");
    for (const request of this.pending.values()) {
      request.reject(error);
    }
    this.pending.clear();
    const listeners = this.closeListeners.splice(0);
    for (const listener of listeners) {
      listener();
    }
  }
}
