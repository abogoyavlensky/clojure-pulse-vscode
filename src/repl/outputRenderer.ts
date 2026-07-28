/**
 * Renders a `Transcript` into a REPL output channel. The channel is created
 * with the `clojure` language id, so everything written stays valid-looking
 * Clojure: prose lines become `;;` comments and values are prefixed with the
 * eval arrow, which keeps syntax highlighting meaningful.
 *
 * Pure (no `vscode` import) — the sink is the structural slice of
 * `vscode.OutputChannel` this needs, which makes it trivial to fake in tests.
 */

import { Transcript, TranscriptEntry } from "./transcript";

export interface OutputSink {
  append(text: string): void;
  clear(): void;
}

/** One transcript entry as the text to append to the channel. */
export function formatEntry(entry: TranscriptEntry): string {
  switch (entry.kind) {
    case "banner":
    case "info":
      return commented(entry.text);
    case "in":
      return `${entry.text}\n`;
    case "value":
      return `=> ${entry.text}\n`;
    // Server output arrives in chunks that carry their own newlines; anything
    // added here would break up multi-chunk lines.
    case "out":
    case "err":
      return entry.text;
  }
}

/** Comments every line, dropping one trailing newline so a line-terminated
 *  message does not render a bare `;; ` at the end. */
function commented(text: string): string {
  const body = text.endsWith("\n") ? text.slice(0, -1) : text;
  return `${body
    .split("\n")
    .map((line) => `;; ${line}`)
    .join("\n")}\n`;
}

/**
 * Mirrors `transcript` into `sink`: existing entries are replayed first, so a
 * channel created after a session has already produced output still shows its
 * history.
 */
export function attachTranscriptRenderer(
  transcript: Transcript,
  sink: OutputSink,
): void {
  for (const entry of transcript.entries()) {
    sink.append(formatEntry(entry));
  }
  // Eviction is ignored on purpose: an output channel is its own scrollback,
  // and rewriting it to drop the oldest lines would fight the user's scroll
  // position for no real gain.
  transcript.onDidAppend((entry) => sink.append(formatEntry(entry)));
  transcript.onDidClear(() => sink.clear());
}
