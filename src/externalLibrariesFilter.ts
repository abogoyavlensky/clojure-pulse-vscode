/**
 * Name matching for the External Libraries search. Pure — no `vscode` — so
 * the rules are unit-testable on their own.
 */

/** Lowercased whitespace-separated terms; empty array = no filter. */
export function parseQuery(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter((term) => term.length > 0);
}

/** What a library shows under `terms`: everything, only `entries`, or nothing. */
export type LibraryMatch = { whole: true } | { whole: false; entries: string[] };

/**
 * A library whose label (`name version`) holds every term is shown whole.
 * Otherwise each entry is tested against `"<label> <path> <namespace>"`, so
 * `aero core`, `aero/core`, and `aero.core` all find `aero/core.cljc`.
 */
export function matchLibrary(
  terms: string[],
  label: string,
  entries: string[],
): LibraryMatch | undefined {
  const lowerLabel = label.toLowerCase();
  if (containsAll(lowerLabel, terms)) {
    return { whole: true };
  }
  const matches = entries.filter((entry) => {
    const path = entry.toLowerCase();
    return containsAll(`${lowerLabel} ${path} ${namespaceForm(path)}`, terms);
  });
  return matches.length > 0 ? { whole: false, entries: matches } : undefined;
}

/** `aero/my_ns.cljc` → `aero.my-ns`: extension dropped, `/` → `.`, `_` → `-`. */
function namespaceForm(path: string): string {
  const slash = path.lastIndexOf("/");
  const dot = path.lastIndexOf(".");
  const stem = dot > slash + 1 ? path.slice(0, dot) : path;
  return stem.replace(/\//g, ".").replace(/_/g, "-");
}

function containsAll(haystack: string, terms: string[]): boolean {
  return terms.every((term) => haystack.includes(term));
}
