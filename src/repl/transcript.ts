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
  private appendListeners: Array<(entry: TranscriptEntry) => void> = [];
  private clearListeners: Array<() => void> = [];

  constructor(private readonly cap: number = DEFAULT_CAP) {}

  append(entry: TranscriptEntry): void {
    this.items.push(entry);
    if (this.items.length > this.cap) {
      this.items.splice(0, this.items.length - this.cap);
    }
    for (const listener of this.appendListeners) {
      listener(entry);
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

  onDidAppend(listener: (entry: TranscriptEntry) => void): void {
    this.appendListeners.push(listener);
  }

  onDidClear(listener: () => void): void {
    this.clearListeners.push(listener);
  }
}
