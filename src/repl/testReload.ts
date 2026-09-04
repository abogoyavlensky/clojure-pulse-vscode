import { EvalOutcome } from "./connectionManager";

/**
 * Reloads the namespaces whose files changed on disk, plus their dependents.
 *
 * `resolve` keeps the form compiling on a runtime without clj-reload on its
 * classpath (and on non-JVM runtimes such as let-go), the same guard the
 * `clojure.test/run-test-var` probe uses. `{:throw false}` makes clj-reload
 * hand back the load failure in its result map instead of throwing, so the
 * extension reads a small map rather than parsing a printed Throwable. The
 * `catch` covers what `:throw false` does not: clj-reload throws out of its
 * own scan when a changed file cannot even be read, and that has to abort the
 * run like any other reload failure rather than look like a missing library.
 *
 * `:tracked` is how many namespaces clj-reload is watching. A project whose
 * `init` ends up matching no files reloads nothing, forever, and says so in
 * exactly the same way as a project with nothing to reload; the count is what
 * tells the two apart. Reading `*state` is reaching into clj-reload, so its
 * own `try` keeps a version that moved the var from breaking the reload.
 */
export const RELOAD_EXPR =
  "(if-let [f (resolve 'clj-reload.core/reload)] " +
  "(try " +
  "(let [r (f {:throw false})] " +
  "(if-some [ex (:exception r)] " +
  "{:failed (:failed r) " +
  ":message (str (ex-message ex) (some->> (ex-cause ex) ex-message (str \": \")))} " +
  "{:loaded (count (:loaded r)) " +
  ":tracked (try (count (:namespaces @@(resolve 'clj-reload.core/*state)))" +
  " (catch Exception _ nil))})) " +
  "(catch Exception e " +
  "{:failed nil " +
  ":message (str (ex-message e) (some->> (ex-cause e) ex-message (str \": \")))})) " +
  ":clojure-pulse/no-reload)";

/**
 * Fixes clj-reload's change baseline: it records file mtimes when
 * `clj-reload.core` is first required. The `try` keeps a missing dependency
 * from writing a stack trace to the REPL output on every connect.
 */
export const PRIME_EXPR =
  "(try (require 'clj-reload.core) (catch Exception _ nil))";

export type ReloadResult =
  | { kind: "unavailable" }
  | { kind: "reloaded"; loaded: number; tracked?: number }
  | { kind: "failed"; ns: string; message: string };

const NO_RELOAD = ":clojure-pulse/no-reload";

/** Reads the value {@link RELOAD_EXPR} returned into a {@link ReloadResult}. */
export function parseReloadOutcome(outcome: EvalOutcome): ReloadResult {
  // With `{:throw false}` a real reload failure never comes back as `err`, so
  // an `err` means the probe itself broke — treat it as no clj-reload.
  if (outcome.err !== undefined) {
    return { kind: "unavailable" };
  }
  const value = outcome.value?.trim() ?? "";
  if (value === NO_RELOAD) {
    return { kind: "unavailable" };
  }
  if (value.includes(":failed")) {
    // `:failed nil` is the scan failure above: no namespace was reached.
    const named = /:failed\s+([^\s,}]+)/.exec(value)?.[1];
    const ns = named === undefined || named === "nil" ? "?" : named;
    const raw = /:message\s+"((?:[^"\\]|\\.)*)"/.exec(value)?.[1];
    const message = raw === undefined ? value : unescapeString(raw);
    // A file clj-reload could not even read fails before it knows whose
    // namespace it was, and the exception it throws then says nothing useful
    // ("Cannot throw exception because \"exception\" is null"). What it
    // printed does name the file, so that is the message worth showing.
    const printed = ns === "?" ? lastLine(outcome.out) : undefined;
    return { kind: "failed", ns, message: printed ?? message };
  }
  const loaded = /:loaded\s+(\d+)/.exec(value)?.[1];
  const tracked = /:tracked\s+(\d+)/.exec(value)?.[1];
  return {
    kind: "reloaded",
    loaded: loaded === undefined ? 0 : Number(loaded),
    ...(tracked === undefined ? {} : { tracked: Number(tracked) }),
  };
}

/** The last non-empty line clj-reload printed, if it printed anything. */
function lastLine(out: string | undefined): string | undefined {
  const lines = (out ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return lines[lines.length - 1];
}

function unescapeString(text: string): string {
  return text.replace(/\\(.)/g, (_, char: string) =>
    char === "n" ? "\n" : char === "t" ? "\t" : char,
  );
}
