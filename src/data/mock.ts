// Domain types — shared across store, components, and screens.
// All sample data has been removed; see git history if needed.

export interface TextBlock     { kind: "text";     text: string }
export interface ThinkingBlock { kind: "thinking"; text: string; dur: string; collapsed?: boolean }
export interface ToolBlock     { kind: "tool";     tool: string; args: string; ok?: boolean; summary?: string; preview?: string }
type Block = TextBlock | ThinkingBlock | ToolBlock;
type AssistantTurn = { role: "assistant"; blocks: Block[] };
type UserTurn      = { role: "user";      text: string };
export type Turn = AssistantTurn | UserTurn;

export interface FileRow {
  name: string; path: string;
  depth?: number; dir?: boolean; open?: boolean;
  status?: "M" | "A" | "??" | "D";
}

export interface Branch {
  n: string; cur?: boolean;
  ahead?: number; behind?: number;
  age: string; merged?: boolean; stale?: boolean;
}

export interface DiffLine { sign: " " | "+" | "-"; text: string }
export interface DiffHunk { file: string; add: number; del: number; sample: DiffLine[] }

export interface Commit { s: string; m: string; who: string; t: string; head?: boolean; merge?: boolean }

export interface KbTag   { name: string; n: number }
export interface KbBlock { id: string; title: string; tags: string[]; updated: string; lines: number; content?: string }

export interface Schedule {
  id: string; name: string; on: boolean;
  when: string; target: string;
  action: "command" | "knowledge";
  detail: string; lastRun: string; nextRun: string;
}

export interface Command {
  id: string; name: string; cmd: string;
  kind?: "claude"; used: number; tags: string[];
}

// Project list, board, roadmap, and planning data now come from the GitHub API / live
// planning session — no sample data remains here.
