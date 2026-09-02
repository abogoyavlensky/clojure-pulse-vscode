/**
 * ClojureDocs, offline: the wire shapes of the server's
 * `clojurePulse/clojureDocs` answer, the markdown the hover shows for one,
 * and the messages for the ways a lookup can come back empty or fail.
 *
 * The server owns the data and the symbol resolution (it reads the export
 * file the extension bundles); this side only renders. Pure — nothing here
 * imports `vscode`, so all of it is unit-tested directly.
 */

/** The server's request method. */
export const CLOJUREDOCS_REQUEST = "clojurePulse/clojureDocs";

/** The first clj-pulse release that answers it. */
export const CLOJUREDOCS_MIN_SERVER = "0.4.0";

/** One var's entry, as the server sends it. */
export interface ClojureDocsEntry {
  ns: string;
  name: string;
  doc?: string;
  /** Bracketed, e.g. `[f coll]`. */
  arglists: string[];
  /** The Clojure version the var appeared in, when known. */
  added?: string;
  /** Community examples, CC0. */
  examples: string[];
  /** Related vars as `ns/name`. */
  seeAlsos: string[];
  /** The var's page on clojuredocs.org. */
  url: string;
}

export interface ClojureDocsResult {
  /** The var the server resolved to; `null` when nothing was under the cursor. */
  symbol: string | null;
  /** `null` when ClojureDocs has no entry for the symbol. */
  entry: ClojureDocsEntry | null;
}

/** What the command sends: the cursor, or a var for see-also navigation. */
export type ClojureDocsParams =
  | { textDocument: { uri: string }; position: { line: number; character: number } }
  | { symbol: string };

/** The information message when the server resolved a var ClojureDocs lacks
 *  (or resolved nothing at all). */
export function noEntryMessage(symbol: string | null): string {
  return symbol
    ? `No ClojureDocs entry for ${symbol}.`
    : "No symbol under the cursor to look up in ClojureDocs.";
}

/** The warning for a failed request: an old server answers method-not-found
 *  (JSON-RPC -32601); anything else carries the server's own message. */
export function describeClojureDocsFailure(
  error: unknown,
  serverVersion: string | undefined,
): string {
  const record = typeof error === "object" && error !== null ? (error as Record<string, unknown>) : {};
  if (record.code === -32601) {
    const running = serverVersion ? ` (running ${serverVersion})` : "";
    return `Show ClojureDocs needs clj-pulse ${CLOJUREDOCS_MIN_SERVER} or newer${running}.`;
  }
  const message =
    error instanceof Error
      ? error.message
      : typeof record.message === "string"
        ? record.message
        : String(error);
  return `ClojureDocs lookup failed: ${message}`;
}

const SHOW_COMMAND = "clojurePulse.showClojureDocs";

/** Backslash-escapes the characters markdown would otherwise interpret in a
 *  var name (`*`, `_`, `` ` ``, brackets, angle brackets). */
function escapeMarkdown(text: string): string {
  return text.replace(/[\\*_`[\]<>]/g, (c) => `\\${c}`);
}

/** A fenced Clojure block whose fence is longer than any backtick run
 *  inside, so the example renders verbatim. */
function fence(code: string): string {
  const longest = Math.max(0, ...(code.match(/`+/g) ?? []).map((run) => run.length));
  const ticks = "`".repeat(Math.max(3, longest + 1));
  return `${ticks}clojure\n${code}\n${ticks}`;
}

/** A link that re-runs Show ClojureDocs for `fqn` (needs a trusted string). */
function seeAlsoLink(fqn: string): string {
  const args = encodeURIComponent(JSON.stringify([fqn]));
  return `[${escapeMarkdown(fqn)}](command:${SHOW_COMMAND}?${args})`;
}

/**
 * The ClojureDocs part of the hover, as markdown. It names the var (after a
 * see-also click the server's part still describes the word under the
 * cursor), then the examples as Clojure fences — VS Code highlights those
 * with the real grammar and theme — then see-also links. Arglists and the
 * docstring are left out: the server's part above already shows them.
 */
export function buildClojureDocsMarkdown(entry: ClojureDocsEntry): string {
  const header = [`**ClojureDocs: ${escapeMarkdown(`${entry.ns}/${entry.name}`)}**`];
  if (entry.added) {
    header.push(`Available since ${escapeMarkdown(entry.added)}`);
  }
  header.push(`[clojuredocs.org](${entry.url})`);

  const parts = [header.join(" · ")];
  if (entry.examples.length === 0) {
    parts.push("No examples on ClojureDocs yet.");
  } else {
    parts.push("**Examples**", ...entry.examples.map(fence));
  }
  if (entry.seeAlsos.length > 0) {
    parts.push(`**See also** ${entry.seeAlsos.map(seeAlsoLink).join(" · ")}`);
  }
  return `${parts.join("\n\n")}\n`;
}
