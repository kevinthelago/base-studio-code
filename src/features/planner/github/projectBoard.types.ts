import type { GhLabel } from "@/shared/lib/github/types";

// ── GitHub data types ─────────────────────────────────────────────────────────

export interface GhUser   { login: string }

export interface BoardIssue {
  id: string;
  number: number;
  title: string;
  body: string;
  labels: GhLabel[];
  assignees: GhUser[];
  comments: number;
  milestone: string | null;
  state: string;
  focused?: boolean;
}

export interface BoardColumn {
  id: string;
  name: string;
  color: string;
}
