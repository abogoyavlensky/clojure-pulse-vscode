/**
 * The project override form: one webview panel, opened as an editor tab, for
 * both adding a project and editing an existing one's classpath overrides.
 *
 * The webview is a dumb renderer (the `customCommandFormPanel` pattern): it
 * posts `ready` when it loads, the host replies with what to show, and every
 * button arrives back as a message that calls `submit`, `requestRemove`, or
 * `cancel` — the same entry points tests drive directly.
 *
 * Everything the panel touches is injected. Writes go through
 * `updateEntries(update)`: the mutation function is applied to the settings
 * value as it is *at write time* (the extension runs it inside its serialized
 * write chain), so a toggle landing between open and save is never clobbered
 * by a stale snapshot. Nothing here imports `vscode`.
 */

import * as crypto from "crypto";
import {
  defaultClasspathCommand,
  ProjectFormErrors,
  projectFormValuesFor,
  ProjectNodeInfo,
  removeProjectEntry,
  upsertProjectEntry,
  validateProjectForm,
  validSettingsPaths,
} from "./projects";

/** Which project the open form is about. */
export type ProjectFormMode =
  | { kind: "add" }
  | { kind: "edit"; project: ProjectNodeInfo };

/** What the form's fields hold — the webview reads and posts exactly this. */
export interface ProjectFormFieldValues {
  path: string;
  classpathEnabled: boolean;
  classpathCommand: string;
}

export interface ProjectFormState {
  mode: ProjectFormMode;
  values: ProjectFormFieldValues;
}

/** Host → webview. The webview renders exactly what this carries. */
export interface ProjectFormLoadMessage {
  type: "load";
  mode: "add" | "edit";
  title: string;
  values: ProjectFormFieldValues;
  /** The effective command, shown greyed in the empty field. */
  commandPlaceholder: string;
  /** lgx resolves dependencies internally; its command field is inert. */
  commandDisabled: boolean;
  /** Whether a settings entry exists — gates the Remove button. */
  hasEntry: boolean;
  errors: ProjectFormErrors & { form?: string };
}

/** The slice of `vscode.Webview` the form uses; a plain object satisfies it. */
export interface ProjectFormWebview {
  html: string;
  postMessage(message: unknown): void | PromiseLike<boolean>;
  onDidReceiveMessage(listener: (message: unknown) => void): void;
}

/** The slice of `vscode.WebviewPanel` the form uses. */
export interface ProjectFormPanelHost {
  title: string;
  webview: ProjectFormWebview;
  reveal(): void;
  dispose(): void;
  onDidDispose(listener: () => void): void;
}

export interface ProjectFormPanelDeps {
  createPanel: () => ProjectFormPanelHost;
  /** The raw, unfiltered settings array — for pre-filling only. */
  readEntries: () => unknown[];
  /** Applies `update` to the settings value as it is at write time, inside
   *  the extension's serialized write chain. The only write path. */
  updateEntries: (update: (raw: unknown[]) => unknown[]) => Promise<void>;
  confirmRemove: (path: string) => Promise<boolean>;
}

export class ProjectFormPanel {
  private panel: ProjectFormPanelHost | undefined;
  private pending: ProjectFormState | undefined;
  /** The form's own operations, serialized — a double-click must not race
   *  itself. (Cross-writer serialization lives in `updateEntries`.) */
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly deps: ProjectFormPanelDeps) {}

  /** The form on screen: what it is about, and what it currently holds. */
  get state(): ProjectFormState | undefined {
    return this.pending;
  }

  /** Every started operation finished — a test hook for message-driven saves. */
  settled(): Promise<void> {
    return this.writes;
  }

  /** Opens the form, reusing the tab when one is already up — the newest
   *  request wins, so a second Edit re-posts rather than opening a rival. */
  open(mode: ProjectFormMode): void {
    this.pending = { mode, values: initialValues(mode, this.deps.readEntries()) };

    const open = this.panel;
    if (open) {
      open.title = titleFor(mode);
      open.reveal();
      this.post();
      return;
    }

    const panel = this.deps.createPanel();
    this.panel = panel;
    panel.title = titleFor(mode);
    panel.webview.html = renderHtml();
    panel.webview.onDidReceiveMessage((message) => this.handle(message));
    panel.onDidDispose(() => {
      if (this.panel === panel) {
        this.panel = undefined;
        this.pending = undefined;
      }
    });
  }

  /** Save: validate, write, close. Nothing is written until it validates, and
   *  a failure leaves the form open with what the user typed. */
  async submit(values: ProjectFormFieldValues): Promise<void> {
    const pending = this.pending;
    if (!pending) {
      return;
    }
    const submitted: ProjectFormState = { mode: pending.mode, values };
    this.pending = submitted;
    // Edit mode acts on the server-known path; add mode on what was typed.
    const path = pending.mode.kind === "edit" ? pending.mode.project.path : values.path;

    try {
      const errors = await this.enqueue(async () => {
        const found = validateProjectForm(
          values,
          validSettingsPaths(this.deps.readEntries()),
          pending.mode.kind,
        );
        if (Object.keys(found).length > 0) {
          return found;
        }
        const command = values.classpathCommand.trim();
        await this.deps.updateEntries((raw) =>
          upsertProjectEntry(raw, path, {
            classpathEnabled: values.classpathEnabled,
            // Blank means "no override": the key is removed, and the
            // server's (or config.edn's) command shows through again.
            classpathCommand: command.length > 0 ? command : undefined,
          }),
        );
        return {};
      });
      if (!this.owns(submitted)) {
        return;
      }
      if (Object.keys(errors).length > 0) {
        this.post(errors);
        return;
      }
      this.close();
    } catch (err: unknown) {
      // A form that has moved on is not this save's to report into.
      if (this.owns(submitted)) {
        this.post({ form: reasonOf(err) });
      }
    }
  }

  /** Remove-from-settings, from the button the edit form carries. */
  async requestRemove(): Promise<void> {
    const pending = this.pending;
    if (!pending || pending.mode.kind !== "edit") {
      return;
    }
    const path = pending.mode.project.path;
    // No entry, nothing to remove — the button is hidden in this state, but
    // the message could still arrive from a stale webview.
    if (!validSettingsPaths(this.deps.readEntries()).includes(path)) {
      return;
    }
    if (!(await this.deps.confirmRemove(path))) {
      return;
    }
    // The form may have moved on (or closed) behind the modal.
    if (!this.owns(pending)) {
      return;
    }
    try {
      await this.enqueue(() =>
        this.deps.updateEntries((raw) => removeProjectEntry(raw, path)),
      );
    } catch (err: unknown) {
      if (this.owns(pending)) {
        this.post({ form: reasonOf(err) });
      }
      return;
    }
    if (this.owns(pending)) {
      this.close();
    }
  }

  /** Whether the form on screen is still the one this operation started on. */
  private owns(state: ProjectFormState): boolean {
    return this.pending === state;
  }

  /** Runs one operation, serialized behind every earlier one. A failed
   *  predecessor does not block the queue. */
  private enqueue<T>(op: () => Promise<T>): Promise<T> {
    const run = this.writes.then(op);
    this.writes = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  cancel(): void {
    this.close();
  }

  close(): void {
    const panel = this.panel;
    this.panel = undefined;
    this.pending = undefined;
    panel?.dispose();
  }

  dispose(): void {
    this.close();
  }

  private handle(message: unknown): void {
    const msg = message as
      | { type?: string; values?: ProjectFormFieldValues }
      | undefined;
    switch (msg?.type) {
      case "ready":
        this.post();
        break;
      case "save":
        if (msg.values) {
          void this.submit(msg.values);
        }
        break;
      case "cancel":
        this.cancel();
        break;
      case "remove":
        void this.requestRemove();
        break;
    }
  }

  private post(errors: ProjectFormLoadMessage["errors"] = {}): void {
    const pending = this.pending;
    const panel = this.panel;
    if (!pending || !panel) {
      return;
    }
    const mode = pending.mode;
    const node = mode.kind === "edit" ? mode.project : undefined;
    const message: ProjectFormLoadMessage = {
      type: "load",
      mode: mode.kind,
      title: titleFor(mode),
      values: pending.values,
      commandPlaceholder: node
        ? (node.cmd ?? defaultClasspathCommand(node.kind))
        : defaultClasspathCommand("deps"),
      commandDisabled: node?.kind === "lgx",
      hasEntry:
        node !== undefined &&
        validSettingsPaths(this.deps.readEntries()).includes(node.path),
      errors,
    };
    void panel.webview.postMessage(message);
  }
}

function initialValues(mode: ProjectFormMode, raw: unknown[]): ProjectFormFieldValues {
  if (mode.kind === "add") {
    return { path: "", classpathEnabled: true, classpathCommand: "" };
  }
  const values = projectFormValuesFor(mode.project, raw);
  return {
    path: values.path,
    classpathEnabled: values.classpathEnabled,
    classpathCommand: values.classpathCommand,
  };
}

function titleFor(mode: ProjectFormMode): string {
  return mode.kind === "add" ? "Add Project" : `Edit Project: ${mode.project.path}`;
}

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The form itself. Rendered once per panel: everything that varies between
 * add and edit arrives in the `load` message. Text reaches the page through
 * `textContent` and `value` only, never `innerHTML`, and the CSP allows
 * nothing but this one script and style.
 */
function renderHtml(): string {
  const nonce = crypto.randomBytes(16).toString("base64");
  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style nonce="${nonce}">
  body {
    margin: 0;
    padding: 16px 20px 28px;
    max-width: 760px;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
  }
  [hidden] { display: none !important; }
  h1 { margin: 0 0 8px; font-size: 1.25em; font-weight: 600; }
  .field { margin-bottom: 18px; }
  .label { display: block; margin-bottom: 4px; font-weight: 600; }
  input[type="text"] {
    width: 100%;
    box-sizing: border-box;
    padding: 4px 6px;
    border-radius: 2px;
    color: var(--vscode-input-foreground);
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, transparent);
    font-family: inherit;
    font-size: inherit;
  }
  input[type="text"]:focus {
    outline: 1px solid var(--vscode-focusBorder);
    outline-offset: -1px;
  }
  input[type="text"]:disabled, input[type="text"]:read-only {
    opacity: 0.7;
  }
  #command { font-family: var(--vscode-editor-font-family, monospace); }
  .invalid { border-color: var(--vscode-inputValidation-errorBorder); }
  .checkbox { display: flex; align-items: center; gap: 8px; }
  .checkbox .label { margin: 0; }
  .hint, .error { margin: 4px 0 0; font-size: 0.9em; }
  .hint { color: var(--vscode-descriptionForeground); }
  .note { margin: 0 0 20px; font-size: 0.9em; color: var(--vscode-descriptionForeground); }
  .error { color: var(--vscode-errorForeground); }
  .buttons { display: flex; align-items: center; gap: 8px; margin-top: 24px; }
  button {
    padding: 4px 14px;
    border: 1px solid var(--vscode-button-border, transparent);
    border-radius: 2px;
    cursor: pointer;
    font-family: inherit;
    font-size: inherit;
    color: var(--vscode-button-foreground);
    background: var(--vscode-button-background);
  }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button:focus-visible {
    outline: 1px solid var(--vscode-focusBorder);
    outline-offset: 2px;
  }
  button.secondary {
    color: var(--vscode-button-secondaryForeground);
    background: var(--vscode-button-secondaryBackground);
  }
  button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
  /* Outlined, set apart from Cancel/Save: removing is rare and should not be
     the loudest thing on the form. */
  #remove {
    margin-right: auto;
    color: var(--vscode-foreground);
    background: transparent;
    border-color: var(--vscode-inputValidation-errorBorder);
  }
  #remove:hover { background: var(--vscode-inputValidation-errorBackground, transparent); }
</style>
</head>
<body>
<h1 id="title"></h1>
<p class="note">These are workspace-settings overrides on top of what clj-pulse
detected. Values set in .clj-pulse/config.edn can be overridden here, but not
unset.</p>
<form id="project-form">
  <div class="field">
    <label class="label" for="path">Path</label>
    <input id="path" type="text" spellcheck="false" autocomplete="off">
    <p class="hint">Relative to the workspace root; "." is the root project.
    Listing a directory detection missed (e.g. gitignored) adds it as a project.</p>
    <p class="error" id="error-path" hidden></p>
  </div>

  <div class="field checkbox">
    <input id="enabled" type="checkbox">
    <label class="label" for="enabled">Resolve full classpath</label>
  </div>
  <p class="hint" id="enabled-hint">Runs the classpath command to index every
  dependency, aliases included. The first run may download dependencies.</p>

  <div class="field">
    <label class="label" for="command">Classpath command</label>
    <input id="command" type="text" spellcheck="false" autocomplete="off">
    <p class="hint" id="command-hint">Leave blank to use the command shown.</p>
    <p class="hint" id="command-lgx" hidden>lgx projects resolve dependencies
    internally; no command runs.</p>
    <p class="error" id="error-command" hidden></p>
  </div>

  <p class="error" id="error-form" hidden></p>

  <div class="buttons">
    <button type="button" id="remove" hidden>Remove from settings</button>
    <button type="button" id="cancel" class="secondary">Cancel</button>
    <button type="submit" id="save">Save</button>
  </div>
</form>
<script nonce="${nonce}">
  const vscodeApi = acquireVsCodeApi();
  const pathField = document.getElementById("path");
  const enabledField = document.getElementById("enabled");
  const commandField = document.getElementById("command");
  const removeButton = document.getElementById("remove");
  const saveButton = document.getElementById("save");

  function setError(id, message) {
    const slot = document.getElementById("error-" + id);
    slot.textContent = message || "";
    slot.hidden = !message;
    const field = document.getElementById(id);
    if (field) {
      field.classList.toggle("invalid", Boolean(message));
    }
  }

  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (!msg || msg.type !== "load") {
      return;
    }
    document.getElementById("title").textContent = msg.title;
    pathField.value = msg.values.path;
    pathField.readOnly = msg.mode === "edit";
    enabledField.checked = msg.values.classpathEnabled;
    commandField.value = msg.values.classpathCommand;
    commandField.placeholder = msg.commandPlaceholder;
    commandField.disabled = msg.commandDisabled;
    document.getElementById("command-hint").hidden = msg.commandDisabled;
    document.getElementById("command-lgx").hidden = !msg.commandDisabled;
    setError("path", msg.errors.path);
    setError("form", msg.errors.form);
    removeButton.hidden = msg.mode !== "edit" || !msg.hasEntry;
    // A failed save answers with a load; the button comes back with it.
    saveButton.disabled = false;
    const focus = msg.mode === "edit" ? commandField : pathField;
    focus.focus();
    if (focus === pathField) {
      focus.select();
    }
  });

  document.getElementById("project-form").addEventListener("submit", (event) => {
    event.preventDefault();
    // One save at a time: a double-click must not race itself.
    saveButton.disabled = true;
    vscodeApi.postMessage({
      type: "save",
      values: {
        path: pathField.value,
        classpathEnabled: enabledField.checked,
        classpathCommand: commandField.disabled ? "" : commandField.value,
      },
    });
  });
  document.getElementById("cancel").addEventListener("click", () => {
    vscodeApi.postMessage({ type: "cancel" });
  });
  removeButton.addEventListener("click", () => {
    vscodeApi.postMessage({ type: "remove" });
  });

  vscodeApi.postMessage({ type: "ready" });
</script>
</body>
</html>`;
}
