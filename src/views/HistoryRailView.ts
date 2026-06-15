// The left-side history rail: a "Recents" list of every Claude Code session,
// styled like the desktop app's sidebar. Read-only over the file store; the
// only action is "click a row → resume", delegated to a callback.

import { ItemView, WorkspaceLeaf, setIcon } from "obsidian";
import { HISTORY_VIEW_TYPE } from "../constants";
import {
  buildFolderTree,
  listSessions,
  type FolderNode,
  type SessionMeta,
} from "../sessions/sessionStore";

type Filter = "recent" | "folder";
export type ResumeHandler = (session: SessionMeta) => void | Promise<void>;

export class HistoryRailView extends ItemView {
  private sessions: readonly SessionMeta[] = [];
  private filter: Filter = "recent";
  private query = "";
  private listEl: HTMLElement | null = null;
  // Folders the user has expanded in the tree, by absolute path. Persists
  // across repaints; the set is only consulted in "folder" mode.
  private expanded = new Set<string>();
  private treeSeeded = false;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly onResume: ResumeHandler,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return HISTORY_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Sessions";
  }

  getIcon(): string {
    return "history";
  }

  async onOpen(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass("obiclaude-rail");

    this.renderControls(root);
    this.listEl = root.createDiv({ cls: "obiclaude-rail-list" });

    await this.reload();
  }

  /** Re-read the store from disk and repaint. */
  async reload(): Promise<void> {
    this.sessions = await listSessions();
    this.renderList();
  }

  private renderControls(root: HTMLElement): void {
    const bar = root.createDiv({ cls: "obiclaude-rail-controls" });

    const search = bar.createEl("input", {
      cls: "obiclaude-rail-search",
      attr: { type: "text", placeholder: "Search sessions…" },
    });
    search.addEventListener("input", () => {
      this.query = search.value.trim().toLowerCase();
      this.renderList();
    });

    const refresh = bar.createEl("button", { cls: "obiclaude-rail-refresh" });
    setIcon(refresh, "refresh-cw");
    refresh.setAttr("aria-label", "Refresh sessions");
    refresh.addEventListener("click", () => void this.reload());

    const pills = root.createDiv({ cls: "obiclaude-rail-pills" });
    this.renderPill(pills, "recent", "Recent");
    this.renderPill(pills, "folder", "By folder");
  }

  private renderPill(parent: HTMLElement, value: Filter, label: string): void {
    const pill = parent.createEl("button", {
      text: label,
      cls: "obiclaude-pill" + (this.filter === value ? " is-active" : ""),
    });
    pill.addEventListener("click", () => {
      this.filter = value;
      parent
        .findAll(".obiclaude-pill")
        .forEach((el) => el.toggleClass("is-active", el === pill));
      this.renderList();
    });
  }

  private renderList(): void {
    const list = this.listEl;
    if (!list) return;
    list.empty();

    const matches = this.query
      ? this.sessions.filter(
          (s) =>
            s.title.toLowerCase().includes(this.query) ||
            s.project.toLowerCase().includes(this.query),
        )
      : this.sessions;

    if (matches.length === 0) {
      list.createDiv({ cls: "obiclaude-rail-empty", text: "No sessions yet." });
      return;
    }

    if (this.filter === "folder") {
      const tree = buildFolderTree(matches);
      if (!this.treeSeeded) {
        // First paint: open top-level folders so the user sees structure
        // instead of a single collapsed root.
        tree.forEach((node) => this.expanded.add(node.path));
        this.treeSeeded = true;
      }
      tree.forEach((node) => this.renderFolder(list, node, 0));
    } else {
      this.renderRecent(list, matches);
    }
  }

  /** Recent: sessions under prominent date-bucket headers (Today, Yesterday…). */
  private renderRecent(
    parent: HTMLElement,
    sessions: readonly SessionMeta[],
  ): void {
    let currentBucket: string | null = null;
    for (const session of sessions) {
      const bucket = dateBucket(session.modifiedMs);
      if (bucket !== currentBucket) {
        currentBucket = bucket;
        parent.createDiv({ cls: "obiclaude-rail-group", text: bucket });
      }
      this.renderRow(parent, session, { showProject: true, indent: 0 });
    }
  }

  /** Render one folder node and, when expanded, its children + sessions. */
  private renderFolder(
    parent: HTMLElement,
    node: FolderNode,
    depth: number,
  ): void {
    // While searching, force everything open so matches are always visible.
    const open = this.query !== "" || this.expanded.has(node.path);

    const header = parent.createDiv({ cls: "obiclaude-tree-folder" });
    header.style.paddingLeft = `${6 + depth * 12}px`;
    header.setAttr("aria-label", node.path);

    const chevron = header.createSpan({ cls: "obiclaude-tree-chevron" });
    setIcon(chevron, open ? "chevron-down" : "chevron-right");

    const folderIcon = header.createSpan({ cls: "obiclaude-tree-icon" });
    setIcon(folderIcon, open ? "folder-open" : "folder");

    header.createSpan({ cls: "obiclaude-tree-name", text: node.name });
    const count = node.sessions.length;
    if (count > 0) {
      header.createSpan({ cls: "obiclaude-tree-count", text: String(count) });
    }

    header.addEventListener("click", () => {
      if (this.expanded.has(node.path)) this.expanded.delete(node.path);
      else this.expanded.add(node.path);
      this.renderList();
    });

    if (!open) return;

    node.children.forEach((child) =>
      this.renderFolder(parent, child, depth + 1),
    );
    node.sessions.forEach((s) =>
      this.renderRow(parent, s, { showProject: false, indent: depth + 1 }),
    );
  }

  private renderRow(
    parent: HTMLElement,
    session: SessionMeta,
    opts: { showProject: boolean; indent: number },
  ): void {
    const row = parent.createDiv({ cls: "obiclaude-row" });
    if (opts.indent > 0) row.style.paddingLeft = `${6 + opts.indent * 12}px`;
    row.setAttr("aria-label", `Resume ${session.title}`);

    row.createDiv({ cls: "obiclaude-row-title", text: session.title });

    const meta = row.createDiv({ cls: "obiclaude-row-meta" });
    if (opts.showProject) {
      meta.createSpan({ cls: "obiclaude-row-tag", text: session.project });
    }
    meta.createSpan({
      cls: "obiclaude-row-time",
      text: relativeTime(session.modifiedMs),
    });

    row.addEventListener("click", () => void this.onResume(session));
  }
}

/** Coarse recency bucket for the "Recent" filter's headers. */
function dateBucket(ms: number): string {
  const now = new Date();
  const startOfToday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  ).getTime();
  const dayMs = 24 * 60 * 60 * 1000;

  if (ms >= startOfToday) return "Today";
  if (ms >= startOfToday - dayMs) return "Yesterday";
  if (ms >= startOfToday - 7 * dayMs) return "Previous 7 days";
  if (ms >= startOfToday - 30 * dayMs) return "Previous 30 days";
  return "Older";
}

/** "2h ago", "yesterday", "3d", "just now" — no Date.now ban issues here (runtime UI). */
function relativeTime(ms: number): string {
  const deltaSec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (deltaSec < 60) return "just now";
  const min = Math.floor(deltaSec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  if (days === 1) return "yesterday";
  return `${days}d ago`;
}
