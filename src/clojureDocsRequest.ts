/**
 * The one-shot request behind Show ClojureDocs.
 *
 * `provideHover` cannot tell a keypress from the mouse resting, and the API
 * that would let a hover expand on demand is still proposed. So the command
 * records where it asked, and the hover provider adds the ClojureDocs part
 * only when VS Code queries that exact document and position within a
 * second. A request is handed out once; a stale one is dropped on the next
 * take. Pure — no `vscode` import — so the rules are unit-tested directly.
 */

export interface ClojureDocsRequest {
  uri: string;
  line: number;
  character: number;
  /** A var to look up instead of the word at the position (see-also links). */
  symbol?: string;
  /** `now()` at the time of recording. */
  at: number;
}

export class PendingClojureDocsRequest {
  private request: ClojureDocsRequest | undefined;
  private taken: ClojureDocsRequest | undefined;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs = 1000,
  ) {}

  /** Replaces any earlier request: only the newest ask can be answered. */
  record(request: Omit<ClojureDocsRequest, "at">): void {
    this.request = { ...request, at: this.now() };
  }

  /**
   * The request for this document and position, once. A stale request is
   * dropped; a fresh one at another position is left for its own query.
   */
  take(uri: string, line: number, character: number): ClojureDocsRequest | undefined {
    const request = this.request;
    if (!request) {
      return undefined;
    }
    if (this.now() - request.at > this.ttlMs) {
      this.request = undefined;
      return undefined;
    }
    if (request.uri !== uri || request.line !== line || request.character !== character) {
      return undefined;
    }
    this.request = undefined;
    this.taken = request;
    return request;
  }

  /** The request most recently handed out — evidence, for tests, that the
   *  command's ask reached the hover provider. */
  get lastTaken(): ClojureDocsRequest | undefined {
    return this.taken;
  }
}
