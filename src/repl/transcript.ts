/**
 * The REPL pane's content as data: an append-only, capped log of typed
 * entries. Pure (no vscode imports) so it is trivially unit-testable; the
 * webview renders from it and re-hydrates by replaying `entries()`.
 */

export type TranscriptEntryKind =
  | "banner"
  | "in"
  | "value"
  | "out"
  | "err"
  | "info";

export interface TranscriptEntry {
  kind: TranscriptEntryKind;
  text: string;
}

const DEFAULT_CAP = 5000;

export class Transcript {
  private items: TranscriptEntry[] = [];
  private appendListeners: Array<
    (entry: TranscriptEntry, evicted: number) => void
  > = [];
  private clearListeners: Array<() => void> = [];

  constructor(private readonly cap: number = DEFAULT_CAP) {}

  append(entry: TranscriptEntry): void {
    this.items.push(entry);
    // Live consumers mirror appends into their own copy (e.g. webview DOM
    // nodes); they must drop the same number of oldest items to stay in
    // sync with entries().
    const evicted = Math.max(0, this.items.length - this.cap);
    if (evicted > 0) {
      this.items.splice(0, evicted);
    }
    for (const listener of this.appendListeners) {
      listener(entry, evicted);
    }
  }

  entries(): TranscriptEntry[] {
    return [...this.items];
  }

  clear(): void {
    this.items = [];
    for (const listener of this.clearListeners) {
      listener();
    }
  }

  onDidAppend(
    listener: (entry: TranscriptEntry, evicted: number) => void,
  ): void {
    this.appendListeners.push(listener);
  }

  onDidClear(listener: () => void): void {
    this.clearListeners.push(listener);
  }
}
