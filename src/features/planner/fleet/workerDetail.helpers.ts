// Shared constants + types for the per-agent WorkerDetail page (#499).

/** Permission-tier → dot color for the WorkerDetail permissions grid. */
export const TIER_COLOR: Record<string, string> = {
  allow: "var(--success)", ask: "var(--accent)", deny: "var(--danger)",
};

/** The modal states the WorkerDetail page can open. */
export type WorkerModal = "steer" | "answer" | "stop" | "profile";
