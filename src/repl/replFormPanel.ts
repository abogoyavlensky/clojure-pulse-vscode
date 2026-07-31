/**
 * The REPL configuration form: one webview panel, opened as an editor tab, for
 * both adding and editing.
 *
 * The webview is a dumb renderer. It posts `ready` when it loads, the host
 * replies with what to show, and every button it offers arrives back here as a
 * message that does nothing but call `submit`, `requestDelete`, or `cancel`.
 * Those methods are the whole contract — VS Code offers no way to post a
 * message *into* a real webview, so tests drive them directly, and they are the
 * very same entry points the form's buttons reach.
 *
 * Everything the panel touches is injected: the panel itself, the raw settings
 * array, the write, the project's default command, and the delete
 * confirmation. Nothing here imports `vscode`.
 */

import * as crypto from "crypto";
import {
  findEntry,
  formValuesFor,
  removeEntry,
  ReplFormErrors,
  ReplFormValues,
  toConfigEntry,
  upsertEntry,
  validateFormValues,
} from "./replConfigEdit";

/** Which REPL the open form is about. */
export type ReplFormMode = { kind: "add" } | { kind: "edit"; name: string };

export interface ReplFormState {
  mode: ReplFormMode;
  values: ReplFormValues;
}

/** Host → webview. The webview renders exactly what this carries. */
export interface ReplFormLoadMessage {
  type: "load";
  mode: "add" | "edit";
  title: string;
  values: ReplFormValues;
  errors: ReplFormErrors;
  commandHint: string;
}

/** The slice of `vscode.Webview` the form uses; a plain object satisfies it. */
export interface ReplFormWebview {
  html: string;
  postMessage(message: unknown): void | PromiseLike<boolean>;
  onDidReceiveMessage(listener: (message: unknown) => void): void;
}

/** The slice of `vscode.WebviewPanel` the form uses. */
export interface ReplFormPanelHost {
  title: string;
  webview: ReplFormWebview;
  reveal(): void;
  dispose(): void;
  onDidDispose(listener: () => void): void;
}

export interface ReplFormPanelDeps {
  createPanel: () => ReplFormPanelHost;
  /** The raw, unfiltered settings array — entries the parser skips included. */
  readEntries: () => unknown[];
  writeEntries: (entries: unknown[]) => Promise<void>;
  /** The command to prefill, and the hint describing where it will run. */
  defaultCommand: () => { command: string; hint: string };
  confirmDelete: (name: string) => Promise<boolean>;
}

export class ReplFormPanel {
  private panel: ReplFormPanelHost | undefined;
  private pending: ReplFormState | undefined;
  private commandHint = "";

  constructor(private readonly deps: ReplFormPanelDeps) {}

  /** The form on screen: what it is about, and what it currently holds. */
  get state(): ReplFormState | undefined {
    return this.pending;
  }

  /** Opens the form, reusing the tab when one is already up — the newest
   *  request wins, so a second Edit re-posts rather than opening a rival. */
  open(mode: ReplFormMode): void {
    const entries = this.deps.readEntries();
    const { command, hint } = this.deps.defaultCommand();
    const entry = mode.kind === "edit" ? findEntry(entries, mode.name) : undefined;
    this.pending = { mode, values: formValuesFor(entry, command) };
    this.commandHint = hint;

    const open = this.panel;
    if (open) {
      open.title = titleFor(mode);
      open.reveal();
      // Already loaded, so it will never ask again: push the new values.
      this.post();
      return;
    }

    const panel = this.deps.createPanel();
    this.panel = panel;
    panel.title = titleFor(mode);
    panel.webview.html = renderHtml();
    panel.webview.onDidReceiveMessage((message) => this.handle(message));
    // The user can close the tab at any time.
    panel.onDidDispose(() => {
      if (this.panel === panel) {
        this.panel = undefined;
        this.pending = undefined;
      }
    });
  }

  /** Save: validate, write, close. Nothing is written until it validates, and
   *  a failure leaves the form open with what the user typed. */
  async submit(values: ReplFormValues): Promise<void> {
    const pending = this.pending;
    if (!pending) {
      return;
    }
    const submitted: ReplFormState = { mode: pending.mode, values };
    this.pending = submitted;
    const originalName = pending.mode.kind === "edit" ? pending.mode.name : undefined;
    const entries = this.deps.readEntries();

    const errors = validateFormValues(values, entries, originalName);
    if (Object.keys(errors).length > 0) {
      this.post(errors);
      return;
    }

    const original =
      originalName === undefined ? undefined : findEntry(entries, originalName);
    const entry = toConfigEntry(values, original);
    try {
      await this.deps.writeEntries(upsertEntry(entries, entry, originalName));
    } catch (err: unknown) {
      // A form that has moved on is not this save's to report into, so a
      // failure that lands too late is dropped rather than shown to the
      // wrong REPL.
      if (this.owns(submitted)) {
        this.post({ form: reasonOf(err) });
      }
      return;
    }
    if (this.owns(submitted)) {
      this.close();
    }
  }

  /** Delete, from the button the edit form carries. */
  async requestDelete(): Promise<void> {
    const pending = this.pending;
    if (!pending || pending.mode.kind !== "edit") {
      return;
    }
    const name = pending.mode.name;
    if (!(await this.deps.confirmDelete(name))) {
      return;
    }
    // The form may have moved to another REPL (or closed) behind the modal.
    if (!this.owns(pending)) {
      return;
    }
    try {
      await this.deps.writeEntries(removeEntry(this.deps.readEntries(), name));
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

  /** Whether the form on screen is still the one this operation started on —
   *  the panel is reused, so a slow write must not close or shout at its
   *  successor. */
  private owns(state: ReplFormState): boolean {
    return this.pending === state;
  }

  cancel(): void {
    this.close();
  }

  /** Closes the tab and drops the pending values. */
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
    const msg = message as { type?: string; values?: ReplFormValues } | undefined;
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
      case "delete":
        void this.requestDelete();
        break;
    }
  }

  private post(errors: ReplFormErrors = {}): void {
    const pending = this.pending;
    const panel = this.panel;
    if (!pending || !panel) {
      return;
    }
    const message: ReplFormLoadMessage = {
      type: "load",
      mode: pending.mode.kind,
      title: titleFor(pending.mode),
      values: pending.values,
      errors,
      commandHint: this.commandHint,
    };
    void panel.webview.postMessage(message);
  }
}

function titleFor(mode: ReplFormMode): string {
  return mode.kind === "add" ? "Add REPL" : `Edit REPL: ${mode.name}`;
}

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The form itself. Rendered once per panel: everything that varies between add
 * and edit — the title, the values, the errors, whether Delete is there —
 * arrives in the `load` message, so reopening the tab on another REPL is a
 * message rather than a re-render. Text reaches the page through `textContent`
 * and `value` only, never `innerHTML`, and the CSP allows nothing but this one
 * script and style.
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
  h1 { margin: 0 0 20px; font-size: 1.25em; font-weight: 600; }
  .field { margin-bottom: 18px; }
  .label { display: block; margin-bottom: 4px; font-weight: 600; }
  input[type="text"], textarea {
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
  textarea {
    font-family: var(--vscode-editor-font-family, monospace);
    resize: vertical;
  }
  input[type="text"]:focus, textarea:focus {
    outline: 1px solid var(--vscode-focusBorder);
    outline-offset: -1px;
  }
  .invalid { border-color: var(--vscode-inputValidation-errorBorder); }
  .hint, .error { margin: 4px 0 0; font-size: 0.9em; }
  .hint { color: var(--vscode-descriptionForeground); }
  .error { color: var(--vscode-errorForeground); }
  .radios { display: flex; flex-wrap: wrap; gap: 20px; }
  .radios label { display: flex; align-items: center; gap: 6px; }
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
  /* Set apart from Cancel and Save, and outlined rather than filled: deleting
     is rare, and should not be the loudest thing on the form. */
  #delete {
    margin-right: auto;
    color: var(--vscode-foreground);
    background: transparent;
    border-color: var(--vscode-inputValidation-errorBorder);
  }
  #delete:hover { background: var(--vscode-inputValidation-errorBackground, transparent); }
</style>
</head>
<body>
<h1 id="title"></h1>
<form id="repl-form">
  <div class="field">
    <span class="label">Type</span>
    <div class="radios">
      <label><input type="radio" name="type" value="create"> Start a REPL</label>
      <label><input type="radio" name="type" value="connect"> Connect to a running REPL</label>
    </div>
  </div>

  <div class="field">
    <label class="label" for="name">Name</label>
    <input id="name" type="text" spellcheck="false" autocomplete="off">
    <p class="hint">Shown in the REPL view, and in its output channel.</p>
    <p class="error" id="error-name" hidden></p>
  </div>

  <div id="create-fields">
    <div class="field">
      <label class="label" for="command">Command</label>
      <textarea id="command" rows="5" spellcheck="false"></textarea>
      <p class="hint" id="command-hint"></p>
      <p class="error" id="error-command" hidden></p>
    </div>
    <div class="field">
      <label class="label" for="cwd">Directory</label>
      <input id="cwd" type="text" spellcheck="false" autocomplete="off">
      <p class="hint">Relative to the workspace root.</p>
      <p class="error" id="error-cwd" hidden></p>
    </div>
  </div>

  <div id="connect-fields">
    <div class="field">
      <label class="label" for="host">Host</label>
      <input id="host" type="text" spellcheck="false" autocomplete="off">
      <p class="hint">Where the running nREPL server is listening.</p>
      <p class="error" id="error-host" hidden></p>
    </div>
    <div class="field">
      <label class="label" for="port">Port</label>
      <input id="port" type="text" spellcheck="false" autocomplete="off">
      <p class="hint">A port number, or a file holding one — .nrepl-port, relative to the workspace root.</p>
      <p class="error" id="error-port" hidden></p>
    </div>
  </div>

  <p class="error" id="error-form" hidden></p>

  <div class="buttons">
    <button type="button" id="delete" hidden>Delete</button>
    <button type="button" id="cancel" class="secondary">Cancel</button>
    <button type="submit" id="save">Save</button>
  </div>
</form>
<script nonce="${nonce}">
  const vscodeApi = acquireVsCodeApi();
  const FIELDS = ["name", "command", "cwd", "host", "port"];
  const radios = Array.from(document.querySelectorAll('input[name="type"]'));
  const deleteButton = document.getElementById("delete");

  function currentType() {
    const checked = radios.find((radio) => radio.checked);
    return checked ? checked.value : "create";
  }

  // Switching type only shows and hides; both groups keep their values, so
  // going back and forth loses nothing the user typed.
  function showFields() {
    const type = currentType();
    document.getElementById("create-fields").hidden = type !== "create";
    document.getElementById("connect-fields").hidden = type !== "connect";
  }

  function readValues() {
    const values = { type: currentType() };
    for (const id of FIELDS) {
      values[id] = document.getElementById(id).value;
    }
    return values;
  }

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
    for (const radio of radios) {
      radio.checked = radio.value === msg.values.type;
    }
    for (const id of FIELDS) {
      document.getElementById(id).value = msg.values[id];
      setError(id, msg.errors[id]);
    }
    setError("form", msg.errors.form);
    document.getElementById("command-hint").textContent = msg.commandHint;
    showFields();
    deleteButton.hidden = msg.mode !== "edit";
    const name = document.getElementById("name");
    name.focus();
    name.select();
  });

  for (const radio of radios) {
    radio.addEventListener("change", showFields);
  }
  document.getElementById("repl-form").addEventListener("submit", (event) => {
    event.preventDefault();
    vscodeApi.postMessage({ type: "save", values: readValues() });
  });
  document.getElementById("cancel").addEventListener("click", () => {
    vscodeApi.postMessage({ type: "cancel" });
  });
  deleteButton.addEventListener("click", () => {
    vscodeApi.postMessage({ type: "delete" });
  });

  vscodeApi.postMessage({ type: "ready" });
</script>
</body>
</html>`;
}
