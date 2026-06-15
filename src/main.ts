// Obiclaude — tmux inside Obsidian + a Claude Code session history rail.
//
// Wires the pieces together and owns the one cross-cutting flow (resume).
// Everything risky (the PTY) sits behind PTYBridgeFactory so it can be swapped
// for the Rust host later without touching this file.

import * as path from "path";
import { Notice, Plugin, WorkspaceLeaf } from "obsidian";
import {
  HISTORY_VIEW_TYPE,
  SESSION_VIEW_TYPE,
  DEFAULT_TMUX_SESSION,
} from "./constants";
import { NodePtyBridgeFactory } from "./pty/NodePtyBridge";
import type { PTYBridgeFactory } from "./pty/PTYBridge";
import {
  createTmuxController,
  type TmuxController,
} from "./tmux/tmuxController";
import { SessionView } from "./views/SessionView";
import { HistoryRailView } from "./views/HistoryRailView";
import type { SessionMeta } from "./sessions/sessionStore";

export default class ObiclaudePlugin extends Plugin {
  private ptyFactory!: PTYBridgeFactory;
  private tmux!: TmuxController;

  async onload(): Promise<void> {
    // node-pty and the tmux config live in the plugin's own folder; resolve its
    // absolute path since the plugin runtime has no module-resolution root.
    const pluginDir = path.join(
      (this.app.vault.adapter as unknown as { basePath: string }).basePath,
      this.manifest.dir ?? "",
    );
    this.ptyFactory = new NodePtyBridgeFactory(
      path.join(pluginDir, "node_modules", "node-pty"),
    );
    this.tmux = createTmuxController({
      configPath: path.join(pluginDir, "obiclaude.tmux.conf"),
    });

    this.registerView(
      SESSION_VIEW_TYPE,
      (leaf) => new SessionView(leaf, this.ptyFactory, this.tmux),
    );
    this.registerView(
      HISTORY_VIEW_TYPE,
      (leaf) => new HistoryRailView(leaf, (s) => this.resume(s)),
    );

    this.addRibbonIcon(
      "terminal-square",
      "Open coding session",
      () => void this.openSessionView(),
    );

    this.addCommand({
      id: "obiclaude-open-session",
      name: "Open coding session",
      callback: () => void this.openSessionView(),
    });
    this.addCommand({
      id: "obiclaude-open-history",
      name: "Open session history rail",
      callback: () => void this.openHistoryRail(),
    });

    // All pane/window control is driven OUT-OF-BAND so the Cmd modifier never
    // needs to reach tmux (macOS terminals can't transmit Cmd). checkCallback
    // gates each command to when a coding session is the active view.
    this.registerSessionCommands();

    // Auto-open the history rail in the left sidebar on first load.
    this.app.workspace.onLayoutReady(() => void this.openHistoryRail());
  }

  private registerSessionCommands(): void {
    const cmd = (
      id: string,
      name: string,
      hotkeys: {
        modifiers: ("Mod" | "Ctrl" | "Shift" | "Alt" | "Meta")[];
        key: string;
      }[],
      action: (s: string) => Promise<void>,
    ): void => {
      this.addCommand({
        id,
        name,
        hotkeys,
        checkCallback: (checking) => this.onActiveSession(checking, action),
      });
    };

    // Two leaders: PANES on ⌘ (Cmd), TABS on ⌃⌥ (Ctrl+Alt). Tabs avoid ⌘ because
    // ⌘T/⌘W/⌘⇧[] all collide with Obsidian's own tab keys. The terminal view
    // intercepts every chord directly while focused (see SessionView) and swallows
    // it — these registrations exist for the command palette + Obsidian settings.

    // Tabs (tmux windows) — ⌃⌥
    cmd(
      "obiclaude-new-tab",
      "New tab",
      [{ modifiers: ["Ctrl", "Alt"], key: "t" }],
      (s) => this.tmux.newWindow(s, "#{pane_current_path}", null, null),
    );
    cmd(
      "obiclaude-close-tab",
      "Close tab",
      [{ modifiers: ["Ctrl", "Alt"], key: "w" }],
      (s) => this.closeTab(s),
    );
    cmd(
      "obiclaude-next-tab",
      "Next tab",
      [{ modifiers: ["Ctrl", "Alt"], key: "]" }],
      (s) => this.tmux.nextWindow(s),
    );
    cmd(
      "obiclaude-prev-tab",
      "Previous tab",
      [{ modifiers: ["Ctrl", "Alt"], key: "[" }],
      (s) => this.tmux.previousWindow(s),
    );

    // Splits / panes — ⌘
    cmd(
      "obiclaude-split-vertical",
      "Split (side by side)",
      [{ modifiers: ["Mod"], key: "Enter" }],
      (s) => this.tmux.splitActive(s, "horizontal"),
    );
    cmd(
      "obiclaude-split-horizontal",
      "Split (stacked)",
      [{ modifiers: ["Mod"], key: "d" }],
      (s) => this.tmux.splitActive(s, "vertical"),
    );
    cmd(
      "obiclaude-kill-pane",
      "Delete active pane",
      [{ modifiers: ["Mod"], key: "Backspace" }],
      (s) => this.tmux.killActivePane(s),
    );
    cmd(
      "obiclaude-toggle-zoom",
      "Zoom active pane",
      [{ modifiers: ["Ctrl", "Shift"], key: "z" }],
      (s) => this.tmux.toggleZoom(s),
    );

    // Pane navigation — ⌘⌥ + Arrows
    cmd(
      "obiclaude-pane-left",
      "Focus pane left",
      [{ modifiers: ["Mod", "Alt"], key: "ArrowLeft" }],
      (s) => this.tmux.selectPane(s, "left"),
    );
    cmd(
      "obiclaude-pane-right",
      "Focus pane right",
      [{ modifiers: ["Mod", "Alt"], key: "ArrowRight" }],
      (s) => this.tmux.selectPane(s, "right"),
    );
    cmd(
      "obiclaude-pane-up",
      "Focus pane up",
      [{ modifiers: ["Mod", "Alt"], key: "ArrowUp" }],
      (s) => this.tmux.selectPane(s, "up"),
    );
    cmd(
      "obiclaude-pane-down",
      "Focus pane down",
      [{ modifiers: ["Mod", "Alt"], key: "ArrowDown" }],
      (s) => this.tmux.selectPane(s, "down"),
    );
  }

  /**
   * Run a tmux action against the active session. With `checking=true` we only
   * report availability (a coding session must be the active view).
   */
  private onActiveSession(
    checking: boolean,
    action: (session: string) => Promise<void>,
  ): boolean {
    const active = this.app.workspace.getActiveViewOfType(SessionView);
    if (!active) return false;
    if (checking) return true;
    void action(DEFAULT_TMUX_SESSION).catch((err: unknown) => {
      new Notice(err instanceof Error ? err.message : String(err), 8000);
    });
    return true;
  }

  async onunload(): Promise<void> {
    // Leave the tmux server running on purpose (persistence). Just detach views.
  }

  /** Open (or focus) the main coding-session leaf in the center. */
  private async openSessionView(): Promise<WorkspaceLeaf> {
    const existing = this.app.workspace.getLeavesOfType(SESSION_VIEW_TYPE);
    if (existing.length > 0) {
      this.app.workspace.revealLeaf(existing[0]);
      return existing[0];
    }
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: SESSION_VIEW_TYPE, active: true });
    this.app.workspace.revealLeaf(leaf);
    return leaf;
  }

  /** Open (or focus) the history rail in the left sidebar — exactly one leaf. */
  private async openHistoryRail(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(HISTORY_VIEW_TYPE);
    if (existing.length > 0) {
      // Detach any duplicates (e.g. from a reload) and keep just the first.
      existing.slice(1).forEach((leaf) => leaf.detach());
      this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = this.app.workspace.getLeftLeaf(false);
    if (!leaf) return;
    await leaf.setViewState({ type: HISTORY_VIEW_TYPE, active: true });
    this.app.workspace.revealLeaf(leaf);
  }

  /**
   * Resume flow: open `claude --resume` in a NEW tmux window (tab).
   *  - Session alive  → add a window and reveal the (attached) leaf.
   *  - Session gone   → create it detached, then RECREATE the leaf so its
   *    onOpen re-attaches (a still-open leaf whose session died is stale and
   *    would otherwise show nothing).
   */
  private async resume(session: SessionMeta): Promise<void> {
    try {
      const command = `claude --resume ${shellQuoteArg(session.id)}`;
      if (await this.tmux.hasSession(DEFAULT_TMUX_SESSION)) {
        await this.tmux.newWindow(
          DEFAULT_TMUX_SESSION,
          session.cwd,
          command,
          session.title,
        );
        await this.openSessionView();
      } else {
        await this.tmux.createDetachedSession(
          DEFAULT_TMUX_SESSION,
          session.cwd,
          command,
          session.title,
        );
        await this.reopenSessionView();
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      new Notice(message, 8000);
    }
  }

  /** Detach any stale session leaves, then open a fresh one that re-attaches. */
  private async reopenSessionView(): Promise<void> {
    this.app.workspace
      .getLeavesOfType(SESSION_VIEW_TYPE)
      .forEach((l) => l.detach());
    await this.openSessionView();
  }

  /** Close the active tab, but refuse to destroy the session via its LAST tab. */
  private async closeTab(session: string): Promise<void> {
    const count = await this.tmux.windowCount(session);
    if (count <= 1) {
      new Notice(
        "Last tab — open another with Cmd+T, or close the coding-session pane to exit.",
        6000,
      );
      return;
    }
    await this.tmux.killWindow(session);
  }
}

/** Single-quote an argument for safe interpolation into the tmux command line. */
function shellQuoteArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
