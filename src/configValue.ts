/**
 * Reading a setting the user *actually set*, as opposed to the default the
 * extension contributes.
 *
 * `WorkspaceConfiguration.get` cannot tell the two apart: it returns the
 * contributed default for an untouched setting. That is wrong for any setting
 * the server merges over its own config file, because sending the default as
 * an explicit override would silently beat what the project file says.
 */

/** The subset of `vscode.WorkspaceConfiguration.inspect`'s result that carries
 *  a user-set value, in ascending order of precedence. */
export interface Inspected<T> {
  globalValue?: T;
  globalLanguageValue?: T;
  workspaceValue?: T;
  workspaceLanguageValue?: T;
  workspaceFolderValue?: T;
  workspaceFolderLanguageValue?: T;
}

/**
 * The effective user-set value, or `undefined` when the setting was never
 * touched at any level. Follows VS Code's own precedence: folder over
 * workspace over global, and a language-specific value over the plain one.
 */
export function configuredValue<T>(inspected: Inspected<T> | undefined): T | undefined {
  return (
    inspected?.workspaceFolderLanguageValue ??
    inspected?.workspaceFolderValue ??
    inspected?.workspaceLanguageValue ??
    inspected?.workspaceValue ??
    inspected?.globalLanguageValue ??
    inspected?.globalValue
  );
}
