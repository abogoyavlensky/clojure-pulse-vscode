import * as net from "net";
import { encode, decodeBuffer, BencodeValue } from "../nrepl/bencode";

type Message = Record<string, BencodeValue | undefined>;

/** Sends one bencoded response; the request's `id` is merged in automatically. */
export type Reply = (response: Record<string, BencodeValue | undefined>) => void;

export type Handler = (msg: Message, reply: Reply, socket: net.Socket) => void;

export interface FakeNrepl {
  port: number;
  /** Every decoded message the server has received, in order. */
  received: Message[];
  /** Replaces the responder for subsequent messages. */
  respond(handler: Handler): void;
  /** Destroys all client sockets (simulates the server dying). */
  dropConnections(): void;
  /** Number of client sockets currently open. */
  socketCount(): number;
  close(): Promise<void>;
}

/**
 * In-test nREPL stand-in: a bencode-speaking TCP server with scriptable
 * responses. Defaults answer `clone`, `describe`, and `eval` well enough for
 * the happy path; tests override with `respond()` for anything else.
 */
export function startFakeNrepl(): Promise<FakeNrepl> {
  const received: Message[] = [];
  const sockets = new Set<net.Socket>();
  let handler: Handler = defaultHandler;

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let pending: Buffer = Buffer.alloc(0);
    socket.on("data", (data) => {
      pending = Buffer.concat([pending, data]);
      const { decoded, rest } = decodeBuffer(pending);
      pending = rest;
      for (const raw of decoded) {
        const msg = raw as Message;
        received.push(msg);
        const reply: Reply = (response) =>
          socket.write(encode({ id: msg.id, ...response }));
        handler(msg, reply, socket);
      }
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as net.AddressInfo;
      resolve({
        port: address.port,
        received,
        respond(next) {
          handler = next;
        },
        dropConnections() {
          for (const socket of sockets) {
            socket.destroy();
          }
        },
        socketCount() {
          return sockets.size;
        },
        close() {
          for (const socket of sockets) {
            socket.destroy();
          }
          return new Promise((res) => server.close(() => res()));
        },
      });
    });
  });
}

function defaultHandler(msg: Message, reply: Reply): void {
  switch (msg.op) {
    case "clone":
      reply({ "new-session": "sess-1", status: ["done"] });
      break;
    case "describe":
      reply({
        versions: {
          nrepl: { "version-string": "1.1.0" },
          clojure: { "version-string": "1.12.0" },
        },
        status: ["done"],
      });
      break;
    case "eval":
    case "load-file":
      reply({ session: msg.session, value: "42" });
      reply({ session: msg.session, status: ["done"] });
      break;
    case "close":
      reply({ status: ["done"] });
      break;
    default:
      reply({ status: ["done", "unknown-op"] });
  }
}
