/**
 * The custom REPL command form: one webview panel, opened as an editor tab,
 * for both adding and editing.
 *
 * The webview is a dumb renderer. It posts `ready` when it loads, the host
 * replies with what to show, and every button it offers arrives back here as a
 * message that does nothing but call `submit`, `requestDelete`, or `cancel`.
 * Those methods are the whole contract — VS Code offers no way to post a
 * message *into* a real webview, so tests drive them directly, and they are the
 * very same entry points the form's buttons reach.
 *
 * Everything the panel touches is injected: the panel itself, the raw settings
 * array, the write, and the delete confirmation. Nothing here imports `vscode`.
 */

import * as crypto from "crypto";
import {
  commandFormValuesFor,
  CommandFormErrors,
  CommandFormValues,
  findCommandEntry,
  removeCommandEntry,
  toCommandEntry,
  upsertCommandEntry,
  validateCommandFormValues,
} from "./customCommands";

/** Which command the open form is about. */
export type CustomCommandFormMode = { kind: "add" } | { kind: "edit"; name: string };

export interface CustomCommandFormState {
  mode: CustomCommandFormMode;
  values: CommandFormValues;
}

/** Host → webview. The webview renders exactly what this carries. */
export interface CustomCommandFormLoadMessage {
  type: "load";
  mode: "add" | "edit";
  title: string;
  values: CommandFormValues;
  errors: CommandFormErrors;
}

/** The slice of `vscode.Webview` the form uses; a plain object satisfies it. */
export interface CustomCommandFormWebview {
  html: string;
  postMessage(message: unknown): void | PromiseLike<boolean>;
  onDidReceiveMessage(listener: (message: unknown) => void): void;
}

/** The slice of `vscode.WebviewPanel` the form uses. */
export interface CustomCommandFormPanelHost {
  title: string;
  webview: CustomCommandFormWebview;
  reveal(): void;
  dispose(): void;
  onDidDispose(listener: () => void): void;
}

export interface CustomCommandFormPanelDeps {
  createPanel: () => CustomCommandFormPanelHost;
  /** The raw, unfiltered settings array — entries the parser skips included. */
  readEntries: () => unknown[];
  writeEntries: (entries: unknown[]) => Promise<void>;
  confirmDelete: (name: string) => Promise<boolean>;
}

export class CustomCommandFormPanel {
  private panel: CustomCommandFormPanelHost | undefined;
  private pending: CustomCommandFormState | undefined;
  /** Settings writes queue up behind this, so an overlapping save derives
   *  from the previous write's result rather than the same snapshot — the
   *  later write must not silently drop the earlier one's change. */
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly deps: CustomCommandFormPanelDeps) {}

  /** The form on screen: what it is about, and what it currently holds. */
  get state(): CustomCommandFormState | undefined {
    return this.pending;
  }

  /** Opens the form, reusing the tab when one is already up — the newest
   *  request wins, so a second Edit re-posts rather than opening a rival. */
  open(mode: CustomCommandFormMode): void {
    const entries = this.deps.readEntries();
    const entry = mode.kind === "edit" ? findCommandEntry(entries, mode.name) : undefined;
    this.pending = { mode, values: commandFormValuesFor(entry) };

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
  async submit(values: CommandFormValues): Promise<void> {
    const pending = this.pending;
    if (!pending) {
      return;
    }
    const submitted: CustomCommandFormState = { mode: pending.mode, values };
    this.pending = submitted;
    const originalName = pending.mode.kind === "edit" ? pending.mode.name : undefined;

    let errors: CommandFormErrors;
    try {
      // Validation and the read both happen inside the queued section: an
      // earlier save still in flight lands first, and this one is judged
      // against its result — a name it just took must conflict here.
      errors = await this.enqueue(async () => {
        const current = this.deps.readEntries();
        const found = validateCommandFormValues(values, current, originalName);
        if (Object.keys(found).length > 0) {
          return found;
        }
        const original =
          originalName === undefined
            ? undefined
            : findCommandEntry(current, originalName);
        await this.deps.writeEntries(
          upsertCommandEntry(current, toCommandEntry(values, original), originalName),
        );
        return {};
      });
    } catch (err: unknown) {
      // A form that has moved on is not this save's to report into, so a
      // failure that lands too late is dropped rather than shown to the
      // wrong command.
      if (this.owns(submitted)) {
        this.post({ form: reasonOf(err) });
      }
      return;
    }
    if (!this.owns(submitted)) {
      return;
    }
    if (Object.keys(errors).length > 0) {
      this.post(errors);
      return;
    }
    this.close();
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
    // The form may have moved to another command (or closed) behind the modal.
    if (!this.owns(pending)) {
      return;
    }
    try {
      await this.enqueue(() =>
        this.deps.writeEntries(removeCommandEntry(this.deps.readEntries(), name)),
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

  /** Whether the form on screen is still the one this operation started on —
   *  the panel is reused, so a slow write must not close or shout at its
   *  successor. */
  private owns(state: CustomCommandFormState): boolean {
    return this.pending === state;
  }

  /** Runs one validate-read-write operation, serialized behind every earlier
   *  one. A failed predecessor does not block the queue — its error belongs
   *  to its own caller. */
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
    const msg = message as { type?: string; values?: CommandFormValues } | undefined;
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

  private post(errors: CommandFormErrors = {}): void {
    const pending = this.pending;
    const panel = this.panel;
    if (!pending || !panel) {
      return;
    }
    const message: CustomCommandFormLoadMessage = {
      type: "load",
      mode: pending.mode.kind,
      title: titleFor(pending.mode),
      values: pending.values,
      errors,
    };
    void panel.webview.postMessage(message);
  }
}

function titleFor(mode: CustomCommandFormMode): string {
  return mode.kind === "add" ? "Add REPL Command" : `Edit REPL Command: ${mode.name}`;
}

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The form itself. Rendered once per panel: everything that varies between add
 * and edit — the title, the values, the errors, whether Delete is there —
 * arrives in the `load` message, so reopening the tab on another command is a
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
<form id="command-form">
  <div class="field">
    <label class="label" for="name">Name</label>
    <input id="name" type="text" spellcheck="false" autocomplete="off">
    <p class="hint">Shown in the REPL Commands view, and usable as keybinding args.</p>
    <p class="error" id="error-name" hidden></p>
  </div>

  <div class="field">
    <label class="label" for="code">Code</label>
    <textarea id="code" rows="5" spellcheck="false"></textarea>
    <p class="hint">Runs in the active REPL. Use fully-qualified symbols, e.g. (user/reset).</p>
    <p class="error" id="error-code" hidden></p>
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
  const FIELDS = ["name", "code"];
  const deleteButton = document.getElementById("delete");

  function readValues() {
    const values = {};
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
    for (const id of FIELDS) {
      document.getElementById(id).value = msg.values[id];
      setError(id, msg.errors[id]);
    }
    setError("form", msg.errors.form);
    deleteButton.hidden = msg.mode !== "edit";
    const name = document.getElementById("name");
    name.focus();
    name.select();
  });

  document.getElementById("command-form").addEventListener("submit", (event) => {
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
