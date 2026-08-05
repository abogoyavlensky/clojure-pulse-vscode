/**
 * Custom REPL commands: what `clojurePulse.customReplCommands` may contain,
 * how a raw settings value is validated into it, and how a command is shown
 * as a tree row. Pure (no `vscode` import) so the settings value is passed in
 * and every rule here is unit-testable.
 */

/** One entry of `clojurePulse.customReplCommands`, after validation. */
export interface CustomReplCommand {
  /** Unique, shown in the pane, referenced by keybinding args. */
  name: string;
  /** Clojure code sent verbatim to the active REPL. */
  code: string;
}

export interface ParsedCustomReplCommands {
  commands: CustomReplCommand[];
  /** One message per skipped entry, for the extension's log channel. */
  warnings: string[];
}

/**
 * Validates the raw `clojurePulse.customReplCommands` value. Invalid entries
 * are skipped with a warning rather than failing the whole list, so one bad
 * hand-edit never empties the pane.
 */
export function parseCustomReplCommands(raw: unknown): ParsedCustomReplCommands {
  if (raw === undefined || raw === null) {
    return { commands: [], warnings: [] };
  }
  if (!Array.isArray(raw)) {
    return {
      commands: [],
      warnings: ["clojurePulse.customReplCommands must be an array."],
    };
  }

  const commands: CustomReplCommand[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();

  raw.forEach((item, index) => {
    const skip = (reason: string): void => {
      warnings.push(`Skipped custom REPL command ${describe(item, index)}: ${reason}`);
    };

    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      skip("expected an object.");
      return;
    }
    const entry = item as Record<string, unknown>;

    const name = typeof entry.name === "string" ? entry.name.trim() : "";
    if (name.length === 0) {
      skip('"name" is required and must be a non-empty string.');
      return;
    }
    if (seen.has(name)) {
      skip(`duplicate name "${name}".`);
      return;
    }

    // Verbatim: only blankness disqualifies, whitespace and layout are kept.
    const code = typeof entry.code === "string" ? entry.code : "";
    if (code.trim().length === 0) {
      skip('"code" is required and must be a non-empty string.');
      return;
    }

    seen.add(name);
    commands.push({ name, code });
  });

  return { commands, warnings };
}

export interface CustomCommandView {
  label: string;
  /** First line of the code — enough to tell rows apart at a glance. */
  description: string;
  /** The full code, for the row's hover. */
  tooltip: string;
  /** Drives which inline actions the view shows (see package.json menus). */
  contextValue: string;
}

export function presentCustomCommand(command: CustomReplCommand): CustomCommandView {
  return {
    label: command.name,
    description: firstLine(command.code),
    tooltip: command.code,
    contextValue: "customReplCommand",
  };
}

function firstLine(code: string): string {
  const line = code.split("\n").find((candidate) => candidate.trim().length > 0);
  return (line ?? "").trim();
}

/**
 * The rules behind the command form: what it starts from, what makes it
 * valid, and how a settings entry is written back. Everything works on the
 * **raw, unfiltered** settings array — an entry the parser only warns about
 * is never matched and therefore survives an edit untouched. Deliberately a
 * parallel of `replConfigEdit.ts` rather than a shared abstraction: two
 * fields do not pay for coupling two settings models.
 */

/** Form fields, all strings — that is what an HTML form carries. */
export interface CommandFormValues {
  name: string;
  code: string;
}

/** Per-field messages, plus `form` for a failure that belongs to no field. */
export type CommandFormErrors = Partial<Record<keyof CommandFormValues, string>> & {
  form?: string;
};

/** What the form opens with: empty for add, an entry's own values for edit. */
export function commandFormValuesFor(entry: unknown): CommandFormValues {
  const raw = asObject(entry);
  const name = typeof raw?.name === "string" ? raw.name.trim() : "";
  const code = typeof raw?.code === "string" ? raw.code : "";
  return { name, code };
}

/**
 * The complaints to show beside the fields, empty when the form may be saved.
 * `originalName` is the entry being edited, which does not conflict with
 * itself.
 */
export function validateCommandFormValues(
  values: CommandFormValues,
  entries: unknown[],
  originalName?: string,
): CommandFormErrors {
  const errors: CommandFormErrors = {};

  const name = values.name.trim();
  if (name.length === 0) {
    errors.name = "Enter a name";
  } else {
    // Only names that actually reach the pane count as taken: an entry the
    // parser skips (say, one with no code) must not block a name.
    const taken = parseCustomReplCommands(entries).commands
      .map((command) => command.name)
      .filter((existing) => existing !== originalName);
    if (taken.includes(name)) {
      errors.name = `"${name}" is already configured`;
    }
  }

  if (values.code.trim().length === 0) {
    errors.code = "Enter the code to run";
  }

  return errors;
}

/**
 * The settings entry a valid form describes. Keys the original carried that
 * this version knows nothing about are kept. The name is trimmed to match
 * what the pane shows; the code is kept exactly as typed.
 */
export function toCommandEntry(
  values: CommandFormValues,
  original?: unknown,
): Record<string, unknown> {
  return { ...asObject(original), name: values.name.trim(), code: values.code };
}

/**
 * Writes `entry` into the array: over the entry named `originalName` that the
 * pane is showing, or appended when there is none, which is both the add case
 * and the case of settings edited from under the form. Every other entry,
 * matched or not, is carried over as it was — later duplicates the parser was
 * already shadowing included.
 */
export function upsertCommandEntry(
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

/** The raw entry behind the command of this name — what an edit form starts
 *  from. */
export function findCommandEntry(entries: unknown[], name: string): unknown {
  const index = indexOfShown(entries, name);
  return index === -1 ? undefined : entries[index];
}

/**
 * Drops the entry with this name; everything else, matched or not, survives.
 * *Every* entry with the name goes: a deleted command must disappear rather
 * than be replaced by a hand-edited duplicate the parser was shadowing.
 */
export function removeCommandEntry(entries: unknown[], name: string): unknown[] {
  return entries.filter((entry) => entryName(entry) !== name);
}

/**
 * Where the command named `name` lives in the raw array. The parser keeps the
 * first entry it *accepts* under a name, which is not always the first entry
 * carrying it: a code-less `{"name": "reset"}` is skipped, and the valid
 * `reset` behind it is the one on screen. Editing must land on that one, or a
 * rename would leave the original command still configured. With nothing
 * parseable under the name, the first entry carrying it is the one the user
 * meant to fix.
 */
function indexOfShown(entries: unknown[], name: string): number {
  let fallback = -1;
  for (const [index, entry] of entries.entries()) {
    if (entryName(entry) !== name) {
      continue;
    }
    // Alone in the array, so only this entry's own validity is judged —
    // duplicate-name shadowing is exactly what this loop is resolving.
    if (parseCustomReplCommands([entry]).commands.length === 1) {
      return index;
    }
    if (fallback === -1) {
      fallback = index;
    }
  }
  return fallback;
}

/** The name a raw entry contributes, normalized as the parser does. */
function entryName(entry: unknown): string | undefined {
  const name = asObject(entry)?.name;
  if (typeof name !== "string") {
    return undefined;
  }
  const trimmed = name.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Identifies an entry in a warning: by name when it has one, else by index. */
function describe(item: unknown, index: number): string {
  if (typeof item === "object" && item !== null && !Array.isArray(item)) {
    const name = (item as Record<string, unknown>).name;
    if (typeof name === "string" && name.trim().length > 0) {
      return `"${name.trim()}"`;
    }
  }
  return `#${index + 1}`;
}
