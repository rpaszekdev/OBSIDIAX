// Reads the Claude Code CLI session store and turns it into a browsable list.
//
// The CLI writes one JSONL file per session under:
//   ~/.claude/projects/<encoded-folder>/<session-id>.jsonl
//
// The encoded-folder name is LOSSY (every "/" becomes "-", so real paths
// containing "-" can't be recovered from it). So instead of decoding the
// folder name, we read the authoritative `cwd` field that the CLI records
// inside each JSONL entry. Recency comes from file mtime.

import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import { CLAUDE_PROJECTS_DIRNAME } from "../constants";

export interface SessionMeta {
  readonly id: string; // session id == filename without .jsonl
  readonly filePath: string; // absolute path to the .jsonl
  readonly cwd: string; // authoritative working directory to resume into
  readonly project: string; // last path segment of cwd, for display
  readonly title: string; // first user prompt (truncated) or fallback
  readonly modifiedMs: number; // mtime, for "recent" sorting
}

const TITLE_MAX = 80;
// cwd and the first user prompt live near the top of a session file, so we read
// only the head rather than whole files (some sessions are megabytes; there can
// be hundreds). Bounds the listing cost regardless of total transcript size.
const HEAD_BYTES = 64 * 1024;

function projectsRoot(): string {
  return path.join(os.homedir(), ".claude", CLAUDE_PROJECTS_DIRNAME);
}

/** Best-effort extraction of cwd + first user prompt from a JSONL session file. */
async function readSessionMetaFields(
  filePath: string,
): Promise<{ cwd: string | null; title: string | null }> {
  let raw: string;
  try {
    const handle = await fs.open(filePath, "r");
    try {
      const buffer = Buffer.alloc(HEAD_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);
      raw = buffer.toString("utf8", 0, bytesRead);
    } finally {
      await handle.close();
    }
  } catch {
    return { cwd: null, title: null };
  }

  let cwd: string | null = null;
  let aiTitle: string | null = null; // best: Claude's auto-generated title
  let userTitle: string | null = null; // fallback: first user prompt

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let entry: unknown;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue; // skip malformed lines rather than failing the whole file
    }
    if (typeof entry !== "object" || entry === null) continue;
    const obj = entry as Record<string, unknown>;

    // The CLI writes a type:"ai-title" line with a human-readable aiTitle —
    // far better than the raw first prompt. Prefer it when present.
    if (
      aiTitle === null &&
      obj.type === "ai-title" &&
      typeof obj.aiTitle === "string"
    ) {
      aiTitle = normalizeTitle(obj.aiTitle);
    }

    if (cwd === null && typeof obj.cwd === "string") {
      cwd = obj.cwd;
    }

    if (userTitle === null) {
      const extracted = extractUserText(obj);
      if (extracted) userTitle = extracted;
    }

    // ai-title + cwd is everything we want; stop early once both are known.
    if (cwd !== null && aiTitle !== null) break;
  }

  return { cwd, title: aiTitle ?? userTitle };
}

/** Pull plain text out of a `type:"user"` entry, tolerating string or block content. */
function extractUserText(obj: Record<string, unknown>): string | null {
  if (obj.type !== "user") return null;
  const message = obj.message;
  if (typeof message !== "object" || message === null) return null;
  const content = (message as Record<string, unknown>).content;

  if (typeof content === "string") {
    return normalizeTitle(content);
  }
  if (Array.isArray(content)) {
    for (const block of content) {
      if (
        typeof block === "object" &&
        block !== null &&
        (block as Record<string, unknown>).type === "text" &&
        typeof (block as Record<string, unknown>).text === "string"
      ) {
        return normalizeTitle(
          (block as Record<string, unknown>).text as string,
        );
      }
    }
  }
  return null;
}

function normalizeTitle(text: string): string | null {
  // Slash-command invocations are wrapped in <command-*> tags and a system
  // reminder block; strip that scaffolding so the title shows the real prompt.
  const stripped = text
    .replace(/<command-[a-z]+>/gi, " ")
    .replace(/<\/command-[a-z]+>/gi, " ")
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, " ");
  const collapsed = stripped.replace(/\s+/g, " ").trim();
  if (!collapsed) return null;
  return collapsed.length > TITLE_MAX
    ? `${collapsed.slice(0, TITLE_MAX - 1)}…`
    : collapsed;
}

/**
 * List every resumable session, newest first. Returns [] (never throws) when
 * the store is missing or unreadable — the rail just shows empty.
 */
export async function listSessions(): Promise<readonly SessionMeta[]> {
  const root = projectsRoot();

  let projectDirs: string[];
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    projectDirs = entries
      .filter((e) => e.isDirectory())
      .map((e) => path.join(root, e.name));
  } catch {
    return [];
  }

  // Collect every .jsonl path first, then process them with bounded concurrency
  // so hundreds of files don't run strictly one-at-a-time (slow) nor all-at-once
  // (file-descriptor exhaustion).
  const filePaths: string[] = [];
  for (const dir of projectDirs) {
    try {
      const files = (await fs.readdir(dir)).filter((f) => f.endsWith(".jsonl"));
      for (const file of files) filePaths.push(path.join(dir, file));
    } catch {
      // Unreadable directory — skip it.
    }
  }

  const sessions = (
    await mapWithConcurrency(filePaths, 24, readSessionMeta)
  ).filter((s): s is SessionMeta => s !== null);

  return sessions.sort((a, b) => b.modifiedMs - a.modifiedMs);
}

/** Build one SessionMeta from a file path, or null if it can't be read. */
async function readSessionMeta(filePath: string): Promise<SessionMeta | null> {
  let modifiedMs = 0;
  try {
    modifiedMs = (await fs.stat(filePath)).mtimeMs;
  } catch {
    return null;
  }

  const { cwd, title } = await readSessionMetaFields(filePath);
  const id = path.basename(filePath).replace(/\.jsonl$/, "");
  const resolvedCwd = cwd ?? os.homedir();

  return {
    id,
    filePath,
    cwd: resolvedCwd,
    project: path.basename(resolvedCwd) || resolvedCwd,
    title: title ?? id,
    modifiedMs,
  };
}

/** Run `fn` over `items` with at most `limit` in flight at once. */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;

  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () =>
    worker(),
  );
  await Promise.all(workers);
  return results;
}

/** Group sessions by their project (cwd basename) for the "by folder" filter. */
export function groupByProject(
  sessions: readonly SessionMeta[],
): ReadonlyMap<string, readonly SessionMeta[]> {
  const map = new Map<string, SessionMeta[]>();
  for (const s of sessions) {
    const bucket = map.get(s.project);
    if (bucket) bucket.push(s);
    else map.set(s.project, [s]);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Folder tree — for the "By folder" filter's file-tree browsing.
//
// Each session carries a full `cwd`; we build a trie keyed on path segments so
// the rail can browse the real directory hierarchy (not just basenames). Nodes
// hold the sessions whose cwd lands exactly on that folder.
// ---------------------------------------------------------------------------

export interface FolderNode {
  readonly name: string; // display segment (may be a collapsed "a/b/c" chain)
  readonly path: string; // absolute path of this node
  readonly children: readonly FolderNode[];
  readonly sessions: readonly SessionMeta[]; // sessions whose cwd === this.path
}

// Mutable shape used only while building; frozen into FolderNode on the way out.
interface MutableNode {
  name: string;
  path: string;
  readonly children: Map<string, MutableNode>;
  readonly sessions: SessionMeta[];
}

function newMutableNode(name: string, path: string): MutableNode {
  return { name, path, children: new Map(), sessions: [] };
}

/**
 * Build a directory tree from sessions' cwds. Returns the top-level nodes
 * (the filesystem root itself is never shown). Single-child folder chains are
 * collapsed into one row (`a/b/c`) so the tree stays shallow, like a file
 * explorer. Sessions within each folder keep the incoming order (newest-first).
 */
export function buildFolderTree(
  sessions: readonly SessionMeta[],
): readonly FolderNode[] {
  const root = newMutableNode("", "");

  for (const session of sessions) {
    const segments = session.cwd
      .split(path.sep)
      .filter((seg) => seg.length > 0);
    let node = root;
    let accumulated = "";
    for (const segment of segments) {
      accumulated = accumulated
        ? `${accumulated}${path.sep}${segment}`
        : `${path.sep}${segment}`;
      let child = node.children.get(segment);
      if (!child) {
        child = newMutableNode(segment, accumulated);
        node.children.set(segment, child);
      }
      node = child;
    }
    node.sessions.push(session);
  }

  return Array.from(root.children.values()).map(finalizeNode);
}

/** Collapse single-child chains and freeze into the readonly FolderNode shape. */
function finalizeNode(node: MutableNode): FolderNode {
  // A folder with exactly one child folder and no sessions of its own is just
  // a passthrough — merge it into the child so the row reads "parent/child".
  if (node.children.size === 1 && node.sessions.length === 0) {
    const [only] = node.children.values();
    const merged = finalizeNode(only);
    return { ...merged, name: `${node.name}${path.sep}${merged.name}` };
  }

  const children = Array.from(node.children.values())
    .map(finalizeNode)
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    name: node.name,
    path: node.path,
    children,
    sessions: node.sessions,
  };
}
