/**
 * Owns every REPL session and the single **active** one that evaluations are
 * routed to.
 *
 * Every session is a configuration — the pane is a projection of settings and
 * nothing else. Sessions are derived from `clojurePulse.replConfigurations`: adding an entry
 * creates one, removing an entry stops and disposes one. A session that is
 * *running* keeps the configuration it launched with — the edited one is held
 * as pending and applied the moment the session next reaches `stopped`, so a
 * live REPL is never quietly described by settings it did not start from.
 *
 * Output channels are owned here, not by the sessions, and memoized by name.
 * That is what lets a session be replaced (an applied edit) without losing the
 * REPL's history: the replacement gets the same channel back.
 */

import { ReplConfig } from "./replConfig";
import { ReplChannel, ReplSessionLike, ReplSessionState } from "./replSession";

export interface ReplRegistryDeps {
  createChannel: (name: string) => ReplChannel;
  createSession: (
    config: ReplConfig,
    channelFor: (name: string) => ReplChannel,
  ) => ReplSessionLike;
}

export class ReplRegistry {
  private items = new Map<string, ReplSessionLike>();
  private readonly channels = new Map<string, ReplChannel>();
  /** Edited configurations waiting for their session to stop. */
  private readonly pendingConfigs = new Map<string, ReplConfig>();
  /** Retired sessions whose server would not die: off the list, but kept so
   *  shutdown can try to kill them once more. */
  private readonly undead = new Set<ReplSessionLike>();
  private activeName: string | undefined;
  private changeListeners: Array<() => void> = [];

  constructor(private readonly deps: ReplRegistryDeps) {}

  get sessions(): ReplSessionLike[] {
    return [...this.items.values()];
  }

  get(name: string): ReplSessionLike | undefined {
    return this.items.get(name);
  }

  /** The session evaluations are routed to. */
  get active(): ReplSessionLike | undefined {
    return this.activeName === undefined ? undefined : this.items.get(this.activeName);
  }

  /** Points evaluations at a session. Only a connected session can be the
   *  target — anything else would advertise a REPL that cannot evaluate. */
  setActive(name: string): void {
    const session = this.items.get(name);
    if (!session || session.state !== "connected" || this.activeName === name) {
      return;
    }
    this.activeName = name;
    this.emitChange();
  }

  onDidChange(listener: () => void): void {
    this.changeListeners.push(listener);
  }

  /**
   * Syncs the session list with the configured one. Resolves once removed
   * sessions have actually shut down; the visible list updates synchronously.
   */
  async setConfigs(configs: ReplConfig[]): Promise<void> {
    const configured = new Set(configs.map((config) => config.name));
    const removed: ReplSessionLike[] = [];
    for (const [name, session] of [...this.items]) {
      if (configured.has(name)) {
        continue;
      }
      this.items.delete(name);
      this.pendingConfigs.delete(name);
      if (this.activeName === name) {
        this.activeName = undefined;
      }
      removed.push(session);
    }

    for (const config of configs) {
      const existing = this.items.get(config.name);
      if (!existing) {
        this.items.set(config.name, this.createSession(config));
      } else if (sameConfig(existing.config, config)) {
        this.pendingConfigs.delete(config.name);
      } else if (existing.state === "stopped") {
        this.replace(existing, config);
      } else {
        this.pendingConfigs.set(config.name, config);
      }
    }

    this.reorder(configs);
    this.emitChange();

    await Promise.all(removed.map((session) => this.retire(session)));
  }

  /**
   * Shuts down a session whose configuration is gone. If its server would not
   * die, the session is remembered (by object, so a re-added configuration of
   * the same name cannot shadow it) and killed again at shutdown; its channel
   * is kept, since it holds the reason the server is still up.
   */
  private async retire(session: ReplSessionLike): Promise<void> {
    try {
      await session.dispose();
    } catch {
      this.undead.add(session);
      return;
    }
    // A settings change may have re-added this name while the shutdown was in
    // flight; that new session owns the channel now.
    if (!this.items.has(session.name)) {
      this.disposeChannel(session.name);
    }
  }

  /** Stops every session and disposes every channel. Awaited by deactivate()
   *  so kills (and their grace periods) really complete. */
  async dispose(): Promise<void> {
    // Everything still alive, including servers an earlier retirement failed
    // to kill — this is the last chance to take them down with us.
    const sessions = [...this.sessions, ...this.undead];
    this.items = new Map();
    this.undead.clear();
    this.pendingConfigs.clear();
    this.activeName = undefined;
    await Promise.all(
      sessions.map((session) => session.dispose().catch(() => {})),
    );
    for (const channel of this.channels.values()) {
      channel.dispose();
    }
    this.channels.clear();
    this.emitChange();
  }

  private createSession(config: ReplConfig): ReplSessionLike {
    const session = this.deps.createSession(config, (name) => this.channelFor(name));
    session.onDidChangeState((state) => this.onSessionState(session, state));
    return session;
  }

  /** Swaps in a session built from `config`, keeping the list position and
   *  the channel; the outgoing session is already stopped. */
  private replace(existing: ReplSessionLike, config: ReplConfig): void {
    this.pendingConfigs.delete(config.name);
    this.items.set(config.name, this.createSession(config));
    // Through retire(), so a server the outgoing session could not kill is
    // remembered for shutdown instead of being lost behind its replacement.
    void this.retire(existing);
  }

  private onSessionState(session: ReplSessionLike, state: ReplSessionState): void {
    if (this.items.get(session.name) !== session) {
      return; // a session already replaced or removed; its state is nobody's business
    }
    if (state === "connected") {
      this.activeName = session.name;
    }
    if (state === "stopped") {
      if (this.activeName === session.name) {
        this.activeName = undefined;
      }
      const pending = this.pendingConfigs.get(session.name);
      if (pending) {
        this.replace(session, pending);
      }
    }
    this.emitChange();
  }

  private channelFor(name: string): ReplChannel {
    let channel = this.channels.get(name);
    if (!channel) {
      channel = this.deps.createChannel(name);
      this.channels.set(name, channel);
    }
    return channel;
  }

  private disposeChannel(name: string): void {
    const channel = this.channels.get(name);
    if (channel) {
      this.channels.delete(name);
      channel.dispose();
    }
  }

  /** Keeps the tree in settings order. */
  private reorder(configs: ReplConfig[]): void {
    const ordered = new Map<string, ReplSessionLike>();
    for (const config of configs) {
      const session = this.items.get(config.name);
      if (session) {
        ordered.set(config.name, session);
      }
    }
    for (const [name, session] of this.items) {
      if (!ordered.has(name)) {
        ordered.set(name, session);
      }
    }
    this.items = ordered;
  }

  private emitChange(): void {
    for (const listener of this.changeListeners) {
      listener();
    }
  }
}

/** Whether two configurations describe the same REPL, field by field. */
function sameConfig(a: ReplConfig, b: ReplConfig): boolean {
  if (a.name !== b.name || a.type !== b.type) {
    return false;
  }
  if (a.type === "create" && b.type === "create") {
    return a.command === b.command && a.cwd === b.cwd;
  }
  if (a.type === "connect" && b.type === "connect") {
    return a.host === b.host && a.port === b.port;
  }
  return false;
}
