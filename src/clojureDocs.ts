/**
 * ClojureDocs, offline: the wire shapes of the server's
 * `clojurePulse/clojureDocs` answer, the HTML the panel shows for one, and
 * the messages for the ways a lookup can come back empty or fail.
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

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);
}

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

/**
 * The panel document for one result. Sections appear only when they have
 * content. See-also links carry `data-symbol`; the inline script posts
 * `{type: "lookup", symbol}` back to the host, which re-renders in place.
 */
export function renderClojureDocsHtml(result: ClojureDocsResult, nonce: string): string {
  const entry = result.entry;
  const title = entry ? `${entry.ns}/${entry.name}` : (result.symbol ?? "ClojureDocs");
  const body = entry
    ? renderEntry(entry)
    : `<p class="muted">${escapeHtml(noEntryMessage(result.symbol))}</p>`;
  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
<style nonce="${nonce}">
  body {
    margin: 0;
    padding: 16px 20px 28px;
    max-width: 860px;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    line-height: 1.5;
  }
  h1 { margin: 0 0 8px; font-size: 1.25em; font-weight: 600; font-family: var(--vscode-editor-font-family, monospace); }
  h2 { margin: 24px 0 8px; font-size: 1em; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: var(--vscode-descriptionForeground); }
  pre, code { font-family: var(--vscode-editor-font-family, monospace); font-size: var(--vscode-editor-font-size, inherit); }
  pre { margin: 0; padding: 8px 10px; border-radius: 3px; background: var(--vscode-textCodeBlock-background); }
  pre.arglists { margin-bottom: 8px; }
  pre.doc { white-space: pre-wrap; background: transparent; padding: 0; }
  pre.example { overflow-x: auto; white-space: pre; }
  .example-block { margin: 0 0 12px; }
  .example-n { font-size: 0.85em; color: var(--vscode-descriptionForeground); margin-bottom: 2px; }
  .since, .muted, .footer { color: var(--vscode-descriptionForeground); }
  .since { margin: 0 0 12px; font-size: 0.9em; }
  ul.see-also { margin: 0; padding-left: 18px; }
  ul.see-also li { font-family: var(--vscode-editor-font-family, monospace); }
  a { color: var(--vscode-textLink-foreground); text-decoration: none; }
  a:hover { text-decoration: underline; }
  .footer { margin-top: 28px; padding-top: 8px; border-top: 1px solid var(--vscode-widget-border, transparent); font-size: 0.85em; }
</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
${body}
<script nonce="${nonce}">
  const vscodeApi = acquireVsCodeApi();
  for (const link of document.querySelectorAll("a[data-symbol]")) {
    link.addEventListener("click", (event) => {
      event.preventDefault();
      vscodeApi.postMessage({ type: "lookup", symbol: link.dataset.symbol });
    });
  }
</script>
</body>
</html>`;
}

function renderEntry(entry: ClojureDocsEntry): string {
  const parts: string[] = [];
  if (entry.arglists.length > 0) {
    parts.push(`<pre class="arglists">${entry.arglists.map(escapeHtml).join("\n")}</pre>`);
  }
  if (entry.added) {
    parts.push(`<p class="since">Available since ${escapeHtml(entry.added)}</p>`);
  }
  if (entry.doc) {
    parts.push(`<pre class="doc">${escapeHtml(entry.doc)}</pre>`);
  }
  if (entry.examples.length > 0) {
    parts.push("<h2>Examples</h2>");
    entry.examples.forEach((example, i) => {
      parts.push(
        `<div class="example-block"><div class="example-n">${i + 1}</div>` +
          `<pre class="example"><code>${escapeHtml(example)}</code></pre></div>`,
      );
    });
  }
  if (entry.seeAlsos.length > 0) {
    parts.push("<h2>See also</h2>");
    parts.push(
      `<ul class="see-also">${entry.seeAlsos
        .map(
          (fqn) =>
            `<li><a href="#" data-symbol="${escapeHtml(fqn)}">${escapeHtml(fqn)}</a></li>`,
        )
        .join("")}</ul>`,
    );
  }
  parts.push(
    `<p class="footer">Examples from <a href="${escapeHtml(entry.url)}">ClojureDocs</a> (CC0). ` +
      "Docstring from Clojure (EPL).</p>",
  );
  return parts.join("\n");
}
