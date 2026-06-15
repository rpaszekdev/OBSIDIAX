// The coding-session leaf: an xterm.js canvas wired to a PTY that runs tmux.
//
// xterm is just glass — it paints bytes from the PTY and sends keystrokes back.
// tmux (launched on open) draws its own splits as escape codes, so we inherit
// real tmux splitting and persistence for free.

import {
  ItemView,
  Notice,
  WorkspaceLeaf,
  type ViewStateResult,
} from "obsidian";
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import type { PTYBridge, PTYBridgeFactory } from "../pty/PTYBridge";
import type { TmuxController } from "../tmux/tmuxController";
import { DEFAULT_TMUX_SESSION, SESSION_VIEW_TYPE } from "../constants";

interface SessionViewState {
  tmuxSession?: string;
}

// Tokyo Night — a polished dark palette. selectionBackground is solid (WebGL
// renders fully-transparent selections inconsistently).
const TOKYO_NIGHT: ITheme = {
  background: "#1a1b26",
  foreground: "#c0caf5",
  cursor: "#c0caf5",
  cursorAccent: "#1a1b26",
  selectionBackground: "#283457",
  black: "#15161e",
  red: "#f7768e",
  green: "#9ece6a",
  yellow: "#e0af68",
  blue: "#7aa2f7",
  magenta: "#bb9af7",
  cyan: "#7dcfff",
  white: "#a9b1d6",
  brightBlack: "#414868",
  brightRed: "#f7768e",
  brightGreen: "#9ece6a",
  brightYellow: "#e0af68",
  brightBlue: "#7aa2f7",
  brightMagenta: "#bb9af7",
  brightCyan: "#7dcfff",
  brightWhite: "#c0caf5",
};

// Read an Obsidian CSS custom property off <body>, falling back when a theme
// (or Obsidian core) leaves it unset — so we never feed xterm an empty string.
function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.body).getPropertyValue(name).trim();
  return v || fallback;
}

// Derive an xterm theme from the ACTIVE Obsidian theme's variables, so the
// embedded terminal matches light/dark and any community theme exactly. Tokyo
// Night supplies the fallback for every var a theme doesn't define.
function obsidianTheme(): ITheme {
  return {
    background: cssVar("--background-primary", TOKYO_NIGHT.background!),
    foreground: cssVar("--text-normal", TOKYO_NIGHT.foreground!),
    cursor: cssVar("--text-accent", TOKYO_NIGHT.cursor!),
    cursorAccent: cssVar("--background-primary", TOKYO_NIGHT.cursorAccent!),
    selectionBackground: cssVar(
      "--text-selection",
      TOKYO_NIGHT.selectionBackground!,
    ),
    black: cssVar("--text-faint", TOKYO_NIGHT.black!),
    red: cssVar("--color-red", TOKYO_NIGHT.red!),
    green: cssVar("--color-green", TOKYO_NIGHT.green!),
    yellow: cssVar("--color-yellow", TOKYO_NIGHT.yellow!),
    blue: cssVar("--color-blue", TOKYO_NIGHT.blue!),
    magenta: cssVar("--color-purple", TOKYO_NIGHT.magenta!),
    cyan: cssVar("--color-cyan", TOKYO_NIGHT.cyan!),
    white: cssVar("--text-muted", TOKYO_NIGHT.white!),
    brightBlack: cssVar("--text-faint", TOKYO_NIGHT.brightBlack!),
    brightRed: cssVar("--color-red", TOKYO_NIGHT.brightRed!),
    brightGreen: cssVar("--color-green", TOKYO_NIGHT.brightGreen!),
    brightYellow: cssVar("--color-yellow", TOKYO_NIGHT.brightYellow!),
    brightBlue: cssVar("--color-blue", TOKYO_NIGHT.brightBlue!),
    brightMagenta: cssVar("--color-purple", TOKYO_NIGHT.brightMagenta!),
    brightCyan: cssVar("--color-cyan", TOKYO_NIGHT.brightCyan!),
    brightWhite: cssVar("--text-normal", TOKYO_NIGHT.brightWhite!),
  };
}

// tmux only accepts hex (#rrggbb) or named colors — never rgb()/hsl(). Pass the
// value through when it's hex, otherwise fall back to a known-good color.
function tmuxColor(name: string, fallback: string): string {
  const v = cssVar(name, fallback);
  return /^#([0-9a-f]{3,8})$/i.test(v) ? v : fallback;
}

// Status-bar (tab strip) colors derived from the Obsidian theme, mirroring the
// xterm palette: secondary bg, muted fg, accent for the active tab.
function statusTheme() {
  return {
    bg: tmuxColor("--background-secondary", "#16161e"),
    fg: tmuxColor("--text-muted", "#787c99"),
    accent: tmuxColor("--interactive-accent", "#7aa2f7"),
    accentFg: tmuxColor("--text-on-accent", "#16161e"),
  };
}

const FONT_STACK =
  '"JetBrainsMono Nerd Font", "JetBrains Mono", "SFMono-Regular", "SF Mono", Menlo, Monaco, "Cascadia Code", monospace';

const FIT_DEBOUNCE_MS = 60;

// Map a keyboard chord to one of our command suffixes (or null to pass through).
// Matched on KeyboardEvent.code so Option's special-character output on macOS
// (⌥] → "'", etc.) never changes the result.
//
// Two leaders, by design:
//  • PANES on ⌘ (Cmd)        — split / kill / zoom / move, the in-session ops.
//  • TABS  on ⌃⌥ (Ctrl+Alt) — new / close / next / prev window. ⌘T/⌘W/⌘⇧[]
//    all collide with Obsidian's own tab keys, so tabs get a free modifier.
function managedCommand(e: KeyboardEvent): string | null {
  const { metaKey, ctrlKey, shiftKey, altKey, code } = e;

  // PANES — ⌘ + key (no Ctrl/Alt/Shift).
  if (metaKey && !ctrlKey && !altKey && !shiftKey) {
    switch (code) {
      case "Enter":
        return "split-vertical"; // ⌘↩ side by side
      case "KeyD":
        return "split-horizontal"; // ⌘D stacked
      case "Backspace":
        return "kill-pane"; // ⌘⌫ close pane
      default:
        return null;
    }
  }

  // Zoom — ⌃⇧Z (⌘Z is undo, so zoom keeps its own chord).
  if (ctrlKey && shiftKey && !metaKey && !altKey && code === "KeyZ") {
    return "toggle-zoom";
  }

  // PANE focus — ⌘⌥ + arrows.
  if (metaKey && altKey && !ctrlKey && !shiftKey) {
    switch (code) {
      case "ArrowLeft":
        return "pane-left";
      case "ArrowRight":
        return "pane-right";
      case "ArrowUp":
        return "pane-up";
      case "ArrowDown":
        return "pane-down";
      default:
        return null;
    }
  }

  // TABS via Ctrl+Tab / Ctrl+Shift+Tab — the Kitty/browser convention. Obsidian
  // binds these to its own tab cycle, so they only reach us once the user clears
  // those hotkeys; we stopPropagation so Obsidian never re-grabs them.
  if (ctrlKey && !metaKey && !altKey && code === "Tab") {
    return shiftKey ? "prev-tab" : "next-tab";
  }

  // TABS — ⌃⌥ + key (no Cmd/Shift). Free of Obsidian's keymap.
  if (ctrlKey && altKey && !metaKey && !shiftKey) {
    switch (code) {
      case "KeyT":
        return "new-tab";
      case "KeyW":
        return "close-tab";
      case "BracketRight":
        return "next-tab"; // ⌃⌥]
      case "BracketLeft":
        return "prev-tab"; // ⌃⌥[
      default:
        return null;
    }
  }

  return null;
}

export class SessionView extends ItemView {
  private term: Terminal | null = null;
  private fit: FitAddon | null = null;
  private pty: PTYBridge | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private intersectionObserver: IntersectionObserver | null = null;
  private fitTimer: number | null = null;
  private tmuxSession: string = DEFAULT_TMUX_SESSION;
  private isClosing = false;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly ptyFactory: PTYBridgeFactory,
    private readonly tmux: TmuxController,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return SESSION_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Coding session";
  }

  getIcon(): string {
    return "terminal-square";
  }

  // Persist the tmux session name so a reopened leaf RE-ATTACHES the running
  // session (the tmux server outlives Obsidian) rather than starting fresh.
  getState(): Record<string, unknown> {
    return { ...super.getState(), tmuxSession: this.tmuxSession };
  }

  async setState(
    state: SessionViewState,
    result: ViewStateResult,
  ): Promise<void> {
    await super.setState(state, result);
    if (state && typeof state.tmuxSession === "string" && state.tmuxSession) {
      this.tmuxSession = state.tmuxSession;
    }
  }

  async onOpen(): Promise<void> {
    const host = this.contentEl;
    host.empty();
    host.addClass("obsidiax-session");

    const term = new Terminal({
      allowProposedApi: true,
      cursorBlink: true,
      cursorStyle: "block",
      fontFamily: FONT_STACK,
      fontSize: 14,
      lineHeight: 1.0, // >1 injects gaps that break box-drawing continuity
      macOptionIsMeta: true, // Option = Meta for readline/emacs word-motions
      scrollback: 10000,
      theme: obsidianTheme(),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    this.term = term;
    this.fit = fit;

    // Fit BEFORE spawning so tmux receives the real viewport size from its very
    // first draw — no post-attach resize to split escape sequences mid-handoff.
    this.safeFit();
    // SINGLE key handler. xterm calls this for every keydown while the terminal
    // is focused; for our managed chords it runs the tmux action and swallows the
    // event (stopPropagation blocks Obsidian, return false blocks the PTY). One
    // handler only — a second interception path double-fired every chord.
    term.attachCustomKeyEventHandler((e) => this.handleKey(e));

    try {
      // Spawn tmux DIRECTLY as the PTY process (no shell). A shell would echo
      // the attach command and its escape fragments into the buffer, corrupting
      // tmux's alternate-screen handoff (the garbled top rows we hunted down).
      const { file, args } = this.tmux.attachArgv(this.tmuxSession);
      const pty = this.ptyFactory.spawn({
        shell: file,
        args,
        cwd: process.env.HOME || "/",
        cols: term.cols,
        rows: term.rows,
        env: { COLORTERM: "truecolor" },
      });
      this.pty = pty;

      pty.onData((chunk) => this.term?.write(chunk));
      pty.onExit(() => {
        if (!this.isClosing) this.term?.writeln("\r\n[session ended]");
      });
      term.onData((data) => this.pty?.write(data));
      term.onResize(({ cols, rows }) => this.pty?.resize(cols, rows));

      // Restyle the tmux status bar to match Obsidian. Deferred so it lands
      // after the server is up from the attach above; failures are non-fatal
      // (the conf's built-in colors remain).
      void this.tmux.setStatusTheme(statusTheme()).catch(() => {});
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      term.writeln("\x1b[31m" + message + "\x1b[0m");
    }

    this.resizeObserver = new ResizeObserver(() => this.scheduleFit());
    this.resizeObserver.observe(host);

    // xterm pauses painting while the leaf is hidden (background tab / Obsidian
    // unfocused); when it becomes visible again the buffer is current but the DOM
    // is stale. Repaint from the buffer on re-entry — safe, since it never mutates
    // the buffer (unlike a tmux redraw).
    this.intersectionObserver = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) this.repaint();
    });
    this.intersectionObserver.observe(host);

    // Re-derive the palette whenever the Obsidian theme (or a CSS snippet)
    // changes, so the terminal tracks light/dark switches live. registerEvent
    // unsubscribes automatically when the view closes.
    this.registerEvent(
      this.app.workspace.on("css-change", () => {
        if (this.term) this.term.options.theme = obsidianTheme();
        void this.tmux.setStatusTheme(statusTheme()).catch(() => {});
      }),
    );

    term.focus();
  }

  /** Drive the tmux action for a managed chord against this view's session. */
  private async dispatchManaged(command: string): Promise<void> {
    const s = this.tmuxSession;
    try {
      switch (command) {
        case "split-vertical":
          return await this.tmux.splitActive(s, "horizontal"); // side by side
        case "split-horizontal":
          return await this.tmux.splitActive(s, "vertical"); // stacked
        case "kill-pane":
          return await this.tmux.killActivePane(s);
        case "toggle-zoom":
          return await this.tmux.toggleZoom(s);
        case "pane-left":
          return await this.tmux.selectPane(s, "left");
        case "pane-right":
          return await this.tmux.selectPane(s, "right");
        case "pane-up":
          return await this.tmux.selectPane(s, "up");
        case "pane-down":
          return await this.tmux.selectPane(s, "down");
        case "next-tab":
          return await this.tmux.nextWindow(s);
        case "prev-tab":
          return await this.tmux.previousWindow(s);
        case "new-tab":
          return await this.tmux.newWindow(
            s,
            "#{pane_current_path}",
            null,
            null,
          );
        case "close-tab": {
          // Refuse to kill the last window — that would tear down the session.
          if ((await this.tmux.windowCount(s)) <= 1) {
            new Notice("OBSIDIAX: can't close the last tab.");
            return;
          }
          return await this.tmux.killWindow(s);
        }
      }
    } catch (err) {
      new Notice(err instanceof Error ? err.message : String(err), 8000);
    }
  }

  /** Repaint the visible viewport from xterm's buffer (no buffer mutation). */
  private repaint(): void {
    if (!this.term) return;
    this.term.refresh(0, this.term.rows - 1);
  }

  /** Key routing — see decision table below. */
  private handleKey(e: KeyboardEvent): boolean {
    if (e.isComposing) return true; // never steal IME composition
    // xterm invokes this handler on keydown, keypress AND keyup. Only act on
    // keydown — otherwise a chord fires its tmux action twice (once on press,
    // once on release), e.g. Ctrl+Tab switches forward then back on release.
    if (e.type !== "keydown") return true;
    // Keep terminal-local editing chords in xterm (copy / paste / select-all),
    // hidden from Obsidian.
    if (
      e.metaKey &&
      (e.code === "KeyC" || e.code === "KeyV" || e.code === "KeyA")
    ) {
      e.stopPropagation();
      return true;
    }
    // Managed window/pane/tab chords: run the tmux action and swallow the event.
    // stopPropagation hides it from Obsidian (no collision); return false keeps
    // it out of the PTY. This is the ONLY place chords are handled — no second
    // path, so nothing fires twice.
    const command = managedCommand(e);
    if (command) {
      e.preventDefault();
      e.stopPropagation();
      void this.dispatchManaged(command);
      return false; // never reaches the PTY
    }
    // Every other Cmd chord bubbles to Obsidian. xterm can't send Cmd to the
    // PTY on macOS, so this costs the terminal nothing and keeps Obsidian
    // globals (Cmd+P, Cmd+O, …) working while focused.
    if (e.metaKey) return false;
    // Everything else — typing and Ctrl-* (incl. tmux's Ctrl+B prefix) — stays
    // in the terminal; stopPropagation so Obsidian single-key hotkeys don't fire.
    e.stopPropagation();
    return true;
  }

  /** Debounced fit so we don't resize mid-CSS-transition (leaves ghost cells). */
  private scheduleFit(): void {
    if (this.fitTimer !== null) window.clearTimeout(this.fitTimer);
    this.fitTimer = window.setTimeout(() => {
      this.fitTimer = null;
      this.safeFit();
    }, FIT_DEBOUNCE_MS);
  }

  private safeFit(): void {
    if (!this.fit || !this.term) return;
    const { offsetWidth, offsetHeight } = this.contentEl;
    if (offsetWidth <= 0 || offsetHeight <= 0) return; // hidden/detached
    try {
      this.fit.fit();
      this.pty?.resize(this.term.cols, this.term.rows);
    } catch {
      // Element may have detached mid-resize; nothing actionable.
    }
  }

  async onClose(): Promise<void> {
    this.isClosing = true;
    if (this.fitTimer !== null) window.clearTimeout(this.fitTimer);
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.intersectionObserver?.disconnect();
    this.intersectionObserver = null;
    // Intentionally do NOT kill the tmux server — detaching this client leaves
    // the session alive so it survives reopening Obsidian. Only tear down the
    // attached client (this view's PTY).
    this.pty?.dispose();
    this.pty = null;
    this.term?.dispose();
    this.term = null;
    this.fit = null;
  }
}
