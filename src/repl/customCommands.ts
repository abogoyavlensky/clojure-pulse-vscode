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
