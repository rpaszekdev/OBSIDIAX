// Shared constants. No hardcoded values scattered across files.

export const SESSION_VIEW_TYPE = "obsidiax-session";
export const HISTORY_VIEW_TYPE = "obsidiax-history";

// The durable tmux session name targeted by all out-of-band commands (-s / -t).
export const DEFAULT_TMUX_SESSION = "obsidiax";

// Directory under ~/.claude holding one subfolder per project of session .jsonl
// files. We read each file's authoritative `cwd` rather than decoding the
// (lossy) dash-encoded subfolder names.
export const CLAUDE_PROJECTS_DIRNAME = "projects";
