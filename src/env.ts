// GUI apps on macOS launch with a minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin),
// missing Homebrew and per-user bin dirs. So tmux (/opt/homebrew/bin) and the
// claude CLI (~/.local/bin) aren't found by child processes we spawn. We fix
// this by prepending the common locations and resolving binaries explicitly.

import { existsSync } from "fs";
import * as os from "os";
import * as path from "path";

// Ordered by precedence; first match wins for a given binary.
const EXTRA_BIN_DIRS = [
  "/opt/homebrew/bin",
  "/opt/homebrew/sbin",
  "/usr/local/bin",
  path.join(os.homedir(), ".local", "bin"),
  path.join(os.homedir(), "bin"),
];

let cachedPath: string | null = null;

/** PATH with the common bin dirs prepended (deduped, existing dirs only). */
export function augmentedPath(): string {
  // The bin dirs don't appear/disappear during a session, and this runs on a
  // hot-ish path (every tmux command + repeated pane nav), so compute once.
  if (cachedPath !== null) return cachedPath;
  const current = process.env.PATH
    ? process.env.PATH.split(path.delimiter)
    : [];
  const dirs = [...EXTRA_BIN_DIRS.filter((d) => existsSync(d)), ...current];
  const seen = new Set<string>();
  const deduped = dirs.filter((d) =>
    seen.has(d) ? false : (seen.add(d), true),
  );
  cachedPath = deduped.join(path.delimiter);
  return cachedPath;
}

/** A copy of process.env with the augmented PATH. */
export function augmentedEnv(
  extra?: Readonly<Record<string, string>>,
): Record<string, string> {
  return {
    ...(process.env as Record<string, string>),
    ...(extra ?? {}),
    PATH: augmentedPath(),
  };
}

/**
 * Resolve an executable to an absolute path by scanning the augmented PATH.
 * Returns the bare name as a fallback (lets the OS try, surfaces a clear ENOENT).
 */
export function resolveBin(name: string): string {
  for (const dir of augmentedPath().split(path.delimiter)) {
    const candidate = path.join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return name;
}
