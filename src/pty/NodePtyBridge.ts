// node-pty implementation of PTYBridge.
//
// node-pty is a NATIVE module — it must match Obsidian's Electron ABI. If it
// fails to load (e.g. after an Electron upgrade), spawn() throws a clear,
// user-facing error rather than crashing silently. That error is the signal
// to swap in the Rust host implementation behind the same interface.

import type {
  PTYBridge,
  PTYBridgeFactory,
  PTYDataListener,
  PTYExitListener,
  PTYSpawnOptions,
} from "./PTYBridge";
import { augmentedEnv } from "../env";

// Minimal shape of the bits of node-pty we use, so we don't depend on its types.
interface IPty {
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

interface NodePtyModule {
  spawn(
    file: string,
    args: string[],
    opts: {
      name: string;
      cols: number;
      rows: number;
      cwd: string;
      env: Record<string, string>;
    },
  ): IPty;
}

function loadNodePty(modulePath: string): NodePtyModule {
  try {
    // Loaded from an explicit absolute path inside the plugin folder, because
    // the plugin runtime has no node_modules resolution path of its own. The
    // binary must match Obsidian's Electron ABI (rebuilt via @electron/rebuild).
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require(modulePath) as NodePtyModule;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `OBSIDIAX: failed to load node-pty from ${modulePath} (native module / Electron ABI mismatch). ` +
        `Rebuild it for this Obsidian version, or switch to the Rust PTY host. Cause: ${detail}`,
    );
  }
}

class NodePtyBridge implements PTYBridge {
  private readonly pty: IPty;
  private disposed = false;

  constructor(pty: IPty) {
    this.pty = pty;
  }

  onData(listener: PTYDataListener): void {
    this.pty.onData((data) => {
      if (!this.disposed) listener(data);
    });
  }

  onExit(listener: PTYExitListener): void {
    this.pty.onExit((e) =>
      listener({ exitCode: e.exitCode, signal: e.signal }),
    );
  }

  write(data: string): void {
    if (this.disposed) return;
    this.pty.write(data);
  }

  resize(cols: number, rows: number): void {
    if (this.disposed) return;
    // node-pty throws on non-positive dimensions; clamp defensively.
    const safeCols = Math.max(1, Math.floor(cols));
    const safeRows = Math.max(1, Math.floor(rows));
    this.pty.resize(safeCols, safeRows);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    try {
      this.pty.kill();
    } catch {
      // Process may already be gone; nothing actionable to do.
    }
  }
}

export class NodePtyBridgeFactory implements PTYBridgeFactory {
  constructor(private readonly modulePath: string) {}

  spawn(options: PTYSpawnOptions): PTYBridge {
    const pty = loadNodePty(this.modulePath);
    // Augment PATH so tmux (Homebrew) and claude (~/.local/bin) resolve inside
    // the shell, despite Obsidian's minimal GUI PATH.
    const env = augmentedEnv({
      ...(options.env ?? {}),
      // Ensure xterm/tmux negotiate a sane terminal.
      TERM: "xterm-256color",
    });
    // Never inherit an outer TMUX — we always want a clean (non-nested) server.
    delete env.TMUX;

    const child = pty.spawn(options.shell, [...(options.args ?? [])], {
      name: "xterm-256color",
      cols: Math.max(1, options.cols),
      rows: Math.max(1, options.rows),
      cwd: options.cwd,
      env,
    });

    return new NodePtyBridge(child);
  }
}
