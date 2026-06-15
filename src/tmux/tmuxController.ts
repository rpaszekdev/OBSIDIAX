// Drives the tmux SERVER out-of-band.
//
// Key insight: tmux is a daemon. Any `tmux <subcommand>` invocation talks to
// the same running server as the client attached inside our xterm. So to open
// a new window/pane we DON'T inject escape sequences into the terminal — we run
// a normal `tmux` command and the attached client reflects it instantly.
//
// MODEL: one tmux session ("obiclaude"); each tmux WINDOW is a tab (rendered by
// tmux's own status bar). Every command targets the session, which tmux
// resolves to its active window/pane.
//
// Robustness baked in (see research):
//  - `env -u TMUX` on attach avoids accidental nesting.
//  - `-f <config>` loads our bundled config when this command starts the server.
//  - Every spawned window/pane gets `-e PATH=<augmented>` so `claude` resolves
//    even if a stale server captured the minimal GUI PATH at first start.

import { execFile } from "child_process";
import { promisify } from "util";
import { augmentedEnv, augmentedPath, resolveBin } from "../env";

const execFileAsync = promisify(execFile);

export type SplitOrientation = "horizontal" | "vertical";
export type PaneDirection = "left" | "right" | "up" | "down";

/** Colors for the tmux status bar (the tab strip), pushed live to match the
 *  active Obsidian theme. All values must be tmux-acceptable (hex or named). */
export interface StatusTheme {
  bg: string; // status bar background
  fg: string; // inactive tab + session-name text
  accent: string; // active tab background
  accentFg: string; // active tab text
}

const PANE_FLAG: Record<PaneDirection, string> = {
  left: "-L",
  right: "-R",
  up: "-U",
  down: "-D",
};

export interface TmuxController {
  /**
   * argv to spawn tmux DIRECTLY as the PTY process (no intermediate shell).
   * Spawning tmux itself — rather than `sh -c 'exec tmux …'` — means the shell
   * never echoes the command, so no command text or split escape sequences ever
   * land in xterm's buffer to corrupt the alternate-screen handoff.
   */
  attachArgv(session: string): { file: string; args: string[] };
  /** Does the server already have this session? (no attach) */
  hasSession(session: string): Promise<boolean>;
  /** Create the session detached, with an optional first command + title. */
  createDetachedSession(
    session: string,
    cwd: string,
    command: string | null,
    title: string | null,
  ): Promise<void>;
  /** Open a new window (tab) in the session, optionally running a command. */
  newWindow(
    session: string,
    cwd: string,
    command: string | null,
    title: string | null,
  ): Promise<void>;
  /** Kill the active window (close the current tab). */
  killWindow(session: string): Promise<void>;
  /** How many windows (tabs) the session has. 0 if the session/server is gone. */
  windowCount(session: string): Promise<number>;
  /** Switch tabs. */
  nextWindow(session: string): Promise<void>;
  previousWindow(session: string): Promise<void>;
  /** Split the active pane (no command — interactive shell). */
  splitActive(session: string, orientation: SplitOrientation): Promise<void>;
  /** Move focus between panes. */
  selectPane(session: string, direction: PaneDirection): Promise<void>;
  /** Kill the active pane. */
  killActivePane(session: string): Promise<void>;
  /** Toggle zoom on the active pane. */
  toggleZoom(session: string): Promise<void>;
  /** Restyle the status bar (tab strip) live to match the Obsidian theme. */
  setStatusTheme(theme: StatusTheme): Promise<void>;
}

class CliTmuxController implements TmuxController {
  constructor(
    private readonly bin: string,
    private readonly configPath: string | null,
    private readonly socket: string,
  ) {}

  attachArgv(session: string): { file: string; args: string[] } {
    // `-L <socket>`: PRIVATE server, isolated from the user's other tmux — so
    // our `-f` config reliably loads (it only applies when the command starts
    // the server, which a private socket guarantees).
    // `-A`: attach-or-create. `-e PATH`: the inaugural window matches later ones
    // even if a stale server existed. Nesting (TMUX) is prevented by the bridge,
    // which strips TMUX from the child env.
    const args = ["-L", this.socket];
    if (this.configPath) args.push("-f", this.configPath);
    args.push(
      "new-session",
      "-A",
      "-s",
      session,
      "-e",
      `PATH=${augmentedPath()}`,
    );
    return { file: this.bin, args };
  }

  async hasSession(session: string): Promise<boolean> {
    try {
      await this.run(["has-session", "-t", session]);
      return true;
    } catch {
      return false; // non-zero exit => session absent
    }
  }

  async createDetachedSession(
    session: string,
    cwd: string,
    command: string | null,
    title: string | null,
  ): Promise<void> {
    // `-f` matters here: this command may be what starts the (private) server.
    // `-A -d` => attach-or-create detached: idempotent, so a double-click that
    // races two creates won't crash with "duplicate session".
    const args: string[] = [];
    if (this.configPath) args.push("-f", this.configPath);
    args.push(
      "new-session",
      "-A",
      "-d",
      "-s",
      session,
      "-c",
      cwd,
      "-e",
      `PATH=${augmentedPath()}`,
    );
    if (title) args.push("-n", sanitizeTitle(title));
    if (command) args.push(command);
    await this.run(args);
  }

  async newWindow(
    session: string,
    cwd: string,
    command: string | null,
    title: string | null,
  ): Promise<void> {
    const args = [
      "new-window",
      "-t",
      session,
      "-c",
      cwd,
      "-e",
      `PATH=${augmentedPath()}`,
    ];
    if (title) args.push("-n", sanitizeTitle(title));
    if (command) args.push(command);
    await this.run(args);
  }

  async killWindow(session: string): Promise<void> {
    await this.run(["kill-window", "-t", session]);
  }

  async windowCount(session: string): Promise<number> {
    try {
      const out = await this.capture([
        "list-windows",
        "-t",
        session,
        "-F",
        "#{window_id}",
      ]);
      return out.split("\n").filter((line) => line.trim().length > 0).length;
    } catch {
      return 0; // no server/session
    }
  }

  async nextWindow(session: string): Promise<void> {
    await this.run(["next-window", "-t", session]);
  }

  async previousWindow(session: string): Promise<void> {
    await this.run(["previous-window", "-t", session]);
  }

  async splitActive(
    session: string,
    orientation: SplitOrientation,
  ): Promise<void> {
    await this.run([
      "split-window",
      orientation === "horizontal" ? "-h" : "-v",
      "-t",
      session,
      "-c",
      "#{pane_current_path}",
      "-e",
      `PATH=${augmentedPath()}`,
    ]);
  }

  async selectPane(session: string, direction: PaneDirection): Promise<void> {
    await this.run(["select-pane", "-t", session, PANE_FLAG[direction]]);
  }

  async killActivePane(session: string): Promise<void> {
    await this.run(["kill-pane", "-t", session]);
  }

  async toggleZoom(session: string): Promise<void> {
    await this.run(["resize-pane", "-Z", "-t", session]);
  }

  async setStatusTheme(t: StatusTheme): Promise<void> {
    // Global on our private server (one isolated server, so -g is safe and
    // applies to every window). tmux redraws the status line immediately.
    await this.run(["set", "-g", "status-style", `bg=${t.bg},fg=${t.fg}`]);
    await this.run(["set", "-g", "status-right", `#[fg=${t.fg}] #S `]);
    await this.run([
      "setw",
      "-g",
      "window-status-current-style",
      `bg=${t.accent},fg=${t.accentFg},bold`,
    ]);
  }

  private async run(args: string[]): Promise<void> {
    await this.capture(args);
  }

  /** Run a tmux subcommand against our private server and return its stdout. */
  private async capture(args: string[]): Promise<string> {
    try {
      // `-L <socket>` targets our private server. Augment PATH so the server
      // (and panes it spawns) can resolve binaries the minimal GUI PATH misses.
      const { stdout } = await execFileAsync(
        this.bin,
        ["-L", this.socket, ...args],
        {
          env: augmentedEnv(),
        },
      );
      return stdout;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Obiclaude: tmux command failed (${args.join(" ")}): ${detail}`,
      );
    }
  }
}

/** Make a tmux-safe window name: single line, no separators, bounded length. */
function sanitizeTitle(title: string): string {
  const clean = title
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[#"']/g, "") // '#' is tmux's format introducer; drop it
    .replace(/^-+/, "") // leading '-' could be mis-parsed as a flag
    .trim();
  // Slice on code POINTS, not UTF-16 units, so we never split an emoji/surrogate.
  const points = Array.from(clean);
  const bounded =
    points.length > 24 ? points.slice(0, 23).join("") + "…" : clean;
  return bounded || "session";
}

export function createTmuxController(options?: {
  tmuxBin?: string;
  configPath?: string;
  socket?: string;
}): TmuxController {
  // Resolve to an absolute path so it works under the minimal GUI PATH.
  return new CliTmuxController(
    options?.tmuxBin ?? resolveBin("tmux"),
    options?.configPath ?? null,
    options?.socket ?? "obiclaude",
  );
}
