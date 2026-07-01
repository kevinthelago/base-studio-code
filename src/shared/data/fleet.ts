// Typed shapes + display maps for the Projects → Fleet page (#401). The page is
// now driven by live app state (#412) — the running fleet roster + coordination
// log — via lib/fleetLive; these are the status/profile display maps the board
// renders. (The original sample dataset was removed once the page went live.)

export type WorkerStatus = "running" | "asking" | "blocked" | "waiting" | "idle" | "done" | "maintenance";
export type FleetProfile = "build" | "review" | "docs" | "auto" | "sandbox";

export interface ProfileMeta { label: string; color: string }
export interface StatusMeta { label: string; color: string }

const ACCENT = "var(--accent)", INFO = "var(--info)", OK = "var(--success)",
  DANGER = "var(--danger)", VIOLET = "oklch(0.7 0.12 290)", DIM = "var(--fg-dim)",
  TEAL = "oklch(0.75 0.10 195)";

/** Profile palette (mirrors agentProfiles colors). */
export const PROFILE: Record<FleetProfile, ProfileMeta> = {
  build:   { label: "Build & test",     color: "oklch(0.78 0.14 70)" },
  review:  { label: "Read-only review", color: "oklch(0.72 0.10 230)" },
  docs:    { label: "Docs writer",      color: "oklch(0.7 0.06 90)" },
  auto:    { label: "Autonomous",       color: "oklch(0.74 0.13 145)" },
  sandbox: { label: "Sandboxed",        color: "oklch(0.68 0.18 25)" },
};

/** Worker status → label + color (also keys the `.wd` status dot class). */
export const STATUS: Record<WorkerStatus, StatusMeta> = {
  running: { label: "running", color: ACCENT },
  asking:  { label: "asking",  color: VIOLET },
  blocked: { label: "blocked", color: DANGER },
  waiting: { label: "waiting", color: INFO },
  idle:    { label: "idle",    color: DIM },
  maintenance: { label: "maintenance", color: TEAL },
  done:    { label: "landed",  color: OK },
};
