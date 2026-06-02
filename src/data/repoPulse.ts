// Typed shapes for the Repo Pulse page (GitHub → Pulse, #402). The page is now
// driven by live GitHub data (#413) — these are the typed view-model shapes the
// pure mappers in lib/repoPulseLive produce; the screen renders off them. (The
// original sample data was removed once the page went live.)

export interface VelocitySlice {
  labels: string[];
  commits: number[];
  merged: number[];
  opened: number[];
  /** additions per day (positive). */
  adds: number[];
  /** deletions per day (stored positive). */
  dels: number[];
}

export interface ChurnArea { area: string; add: number; del: number; files: number; color: string }
export interface ChurnFile { p: string; w: number }
export interface Contributor { name: string; bot: boolean; commits: number; add: number; del: number; color: string }
export interface Workflow { name: string; runs: number; pass: number; min: number }

export type BranchStatusKey = "open-pr" | "ci-running" | "draft" | "blocked" | "commit-only" | "integration";
export interface Branch {
  n: string; owner: string; bot: boolean; ahead: number; behind: number;
  status: BranchStatusKey; age: string; color: string;
}

const G = "var(--success)", A = "var(--accent)", D = "var(--danger)", DIM = "var(--fg-dim)";

/** Branch status → display label + color. */
export const BRANCH_STATUS: Record<BranchStatusKey, { label: string; color: string }> = {
  "open-pr": { label: "PR open", color: G },
  "ci-running": { label: "CI running", color: A },
  draft: { label: "draft", color: DIM },
  blocked: { label: "blocked", color: D },
  "commit-only": { label: "commit-only", color: DIM },
  integration: { label: "integration", color: A },
};
