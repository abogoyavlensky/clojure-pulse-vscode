import { EvalOutcome } from "./connectionManager";

/**
 * Reloads the namespaces whose files changed on disk, plus their dependents.
 *
 * `resolve` keeps the form compiling on a runtime without clj-reload on its
 * classpath (and on non-JVM runtimes such as let-go), the same guard the
 * `clojure.test/run-test-var` probe uses. `{:throw false}` makes clj-reload
 * hand back the load failure in its result map instead of throwing, so the
 * extension reads a small map rather than parsing a printed Throwable.
 */
export const RELOAD_EXPR =
  "(if-let [f (resolve 'clj-reload.core/reload)] " +
  "(let [r (f {:throw false})] " +
  "(if-some [ex (:exception r)] " +
  "{:failed (:failed r) " +
  ":message (str (ex-message ex) (some->> (ex-cause ex) ex-message (str \": \")))} " +
  "{:loaded (count (:loaded r))})) " +
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
  | { kind: "reloaded"; loaded: number }
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
    const ns = /:failed\s+([^\s,}]+)/.exec(value)?.[1] ?? "?";
    const message = /:message\s+"((?:[^"\\]|\\.)*)"/.exec(value)?.[1];
    return {
      kind: "failed",
      ns,
      message: message === undefined ? value : unescapeString(message),
    };
  }
  const loaded = /:loaded\s+(\d+)/.exec(value)?.[1];
  return { kind: "reloaded", loaded: loaded === undefined ? 0 : Number(loaded) };
}

function unescapeString(text: string): string {
  return text.replace(/\\(.)/g, (_, char: string) =>
    char === "n" ? "\n" : char === "t" ? "\t" : char,
  );
}
