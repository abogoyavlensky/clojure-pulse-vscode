/**
 * The rules behind the REPL configuration form: what a form starts from, what
 * makes it valid, and how a settings entry is written back. Pure (no `vscode`
 * import) so the webview and the commands share one implementation and every
 * rule here is unit-testable.
 *
 * Everything works on the **raw, unfiltered** settings array. An entry the
 * parser only warns about — a stray scalar, a `create` with no command — is
 * never matched and therefore survives an edit untouched.
 */

import {
  configEntryName,
  parseReplConfigurations,
  validatePortInput,
} from "./replConfig";

/** Form fields, all strings — that is what an HTML form carries. */
export interface ReplFormValues {
  name: string;
  type: "create" | "connect";
  command: string;
  cwd: string;
  host: string;
  port: string;
}

/** Per-field messages, plus `form` for a failure that belongs to no field. */
export type ReplFormErrors = Partial<Record<keyof ReplFormValues, string>> & {
  form?: string;
};

const DEFAULT_CWD = ".";
const DEFAULT_HOST = "localhost";
const DEFAULT_PORT = ".nrepl-port";

/**
 * What the form opens with: the add defaults, or an entry's own values falling
 * back to those defaults for anything it leaves out. Both field sets are
 * filled, so switching the type selector back and forth loses nothing.
 */
export function formValuesFor(entry: unknown, defaultCommand: string): ReplFormValues {
  const raw = asObject(entry);
  return {
    name: configEntryName(raw) ?? "",
    type: raw?.type === "connect" ? "connect" : "create",
    command: text(raw?.command) ?? defaultCommand,
    cwd: text(raw?.cwd) ?? DEFAULT_CWD,
    host: text(raw?.host) ?? DEFAULT_HOST,
    port: portText(raw?.port) ?? DEFAULT_PORT,
  };
}

/**
 * The complaints to show beside the fields, empty when the form may be saved.
 * `originalName` is the entry being edited, which does not conflict with
 * itself.
 */
export function validateFormValues(
  values: ReplFormValues,
  entries: unknown[],
  originalName?: string,
): ReplFormErrors {
  const errors: ReplFormErrors = {};

  const name = values.name.trim();
  if (name.length === 0) {
    errors.name = "Enter a name";
  } else {
    // Only names that actually reach the tree count as taken: an entry the
    // parser skips (say, a `create` with no command) must not block a name.
    const taken = parseReplConfigurations(entries).configs
      .map((config) => config.name)
      .filter((existing) => existing !== originalName);
    if (taken.includes(name)) {
      errors.name = `"${name}" is already configured`;
    }
  }

  if (values.type === "create") {
    if (values.command.trim().length === 0) {
      errors.command = "Enter a command";
    }
  } else {
    const port = validatePortInput(values.port);
    if (port !== undefined) {
      errors.port = port;
    }
  }

  return errors;
}

/**
 * The settings entry a valid form describes. Keys the original carried that
 * this version knows nothing about are kept; keys belonging to the *other*
 * type are dropped, so switching `create` → `connect` removes `command` and
 * `cwd`. Values equal to their default are left out entirely.
 */
export function toConfigEntry(
  values: ReplFormValues,
  original?: unknown,
): Record<string, unknown> {
  const entry: Record<string, unknown> = { ...asObject(original) };
  entry.name = values.name.trim();
  entry.type = values.type;

  if (values.type === "create") {
    entry.command = values.command.trim();
    setOrOmit(entry, "cwd", values.cwd, DEFAULT_CWD);
    delete entry.host;
    delete entry.port;
  } else {
    setOrOmit(entry, "host", values.host, DEFAULT_HOST);
    const port = values.port.trim();
    entry.port = /^\d+$/.test(port) ? Number.parseInt(port, 10) : port;
    delete entry.command;
    delete entry.cwd;
  }

  return entry;
}

/**
 * Writes `entry` into the array: over the entry named `originalName` that the
 * tree is showing, or appended when there is none, which is both the add case
 * and the case of settings edited from under the form. Every other entry,
 * matched or not, is carried over as it was — later duplicates the parser was
 * already shadowing included.
 */
export function upsertEntry(
  entries: unknown[],
  entry: Record<string, unknown>,
  originalName?: string,
): unknown[] {
  const next = [...entries];
  const index = originalName === undefined ? -1 : indexOfShown(next, originalName);
  if (index === -1) {
    next.push(entry);
  } else {
    next[index] = entry;
  }
  return next;
}

/**
 * Where the REPL named `name` lives in the raw array. The parser keeps the
 * first entry it *accepts* under a name, which is not always the first entry
 * carrying it: a malformed `{"name": "dev"}` is skipped, and the valid `dev`
 * behind it is the one on screen. Editing must land on that one, or a rename
 * would leave the original REPL still configured. With nothing parseable under
 * the name, the first entry carrying it is the one the user meant to fix.
 */
function indexOfShown(entries: unknown[], name: string): number {
  let fallback = -1;
  for (const [index, entry] of entries.entries()) {
    if (configEntryName(entry) !== name) {
      continue;
    }
    // Alone in the array, so only this entry's own validity is judged —
    // duplicate-name shadowing is exactly what this loop is resolving.
    if (parseReplConfigurations([entry]).configs.length === 1) {
      return index;
    }
    if (fallback === -1) {
      fallback = index;
    }
  }
  return fallback;
}

/**
 * Drops the entry with this name; everything else, matched or not, survives.
 * *Every* entry with the name goes: a deleted REPL must disappear rather than
 * be replaced by a hand-edited duplicate the parser was shadowing.
 */
export function removeEntry(entries: unknown[], name: string): unknown[] {
  return entries.filter((entry) => configEntryName(entry) !== name);
}

/** Sets a trimmed value, or removes the key when it is empty or the default. */
function setOrOmit(
  entry: Record<string, unknown>,
  key: string,
  value: string,
  fallback: string,
): void {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed === fallback) {
    delete entry[key];
  } else {
    entry[key] = trimmed;
  }
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** A field's value when it carries one, so absent and blank both fall back. */
function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function portText(value: unknown): string | undefined {
  return typeof value === "number" ? String(value) : text(value);
}
