// The single seam that isolates the one piece of real engineering risk.
//
// Today this is backed by node-pty (fast to wire up). Tomorrow a bundled
// Rust/Go portable-pty host can implement the SAME interface and drop in
// without touching SessionView, HistoryRail, or main.ts.
//
// Keep this interface tiny and transport-agnostic on purpose.

export interface PTYSpawnOptions {
  readonly shell: string;
  readonly args?: readonly string[];
  readonly cwd: string;
  readonly cols: number;
  readonly rows: number;
  readonly env?: Readonly<Record<string, string>>;
}

export type PTYDataListener = (chunk: string) => void;
export type PTYExitListener = (info: {
  exitCode: number;
  signal?: number;
}) => void;

/**
 * A bidirectional pseudo-terminal. Implementations own the native/process
 * details; consumers only see strings in and strings out.
 */
export interface PTYBridge {
  /** Bytes coming FROM the shell (to be painted by xterm). */
  onData(listener: PTYDataListener): void;
  /** The shell process ended. */
  onExit(listener: PTYExitListener): void;
  /** Keystrokes going TO the shell. */
  write(data: string): void;
  /** Tell the shell the viewport changed size. */
  resize(cols: number, rows: number): void;
  /** Terminate the underlying process and release resources. */
  dispose(): void;
}

/** Factory so the rest of the app never imports a concrete bridge directly. */
export interface PTYBridgeFactory {
  spawn(options: PTYSpawnOptions): PTYBridge;
}
