// Capability model for code-bearing extensions (#598 M3). A code pipeline declares the
// capabilities it needs in its manifest; the app shows them at install, the user
// approves, and the sandbox enforces them. Pure + framework-free.

import { type Capability } from "./manifest";

export const ALL_CAPABILITIES: Capability[] = ["read-signals", "write-files", "render", "network"];

export type Risk = "low" | "medium" | "high";

export interface CapabilityInfo {
  id: Capability;
  label: string;
  risk: Risk;
  description: string;
}

/** Human-facing copy + risk for the install consent dialog. */
export const CAPABILITY_INFO: Record<Capability, CapabilityInfo> = {
  "read-signals": {
    id: "read-signals", label: "Read plan signals", risk: "low",
    description: "Read the plan's published signals (issue / repo counts, stage flags). Read-only.",
  },
  render: {
    id: "render", label: "Render a preview", risk: "low",
    description: "Draw UI / 3D output into a sandboxed preview surface. No system access.",
  },
  "write-files": {
    id: "write-files", label: "Write project files", risk: "high",
    description: "Create or modify files in the project (e.g. generated components).",
  },
  network: {
    id: "network", label: "Network access", risk: "high",
    description: "Make network requests (e.g. call an external service).",
  },
};

export function isCapability(v: string): v is Capability {
  return (ALL_CAPABILITIES as string[]).includes(v);
}

/**
 * Split requested capability strings into known + unknown. An unknown capability means
 * the manifest targets a newer app — callers refuse rather than silently granting
 * nothing. Deduped.
 */
export function partitionCapabilities(requested: readonly string[]): { known: Capability[]; unknown: string[] } {
  const known = new Set<Capability>();
  const unknown = new Set<string>();
  for (const c of requested) {
    if (isCapability(c)) known.add(c);
    else unknown.add(c);
  }
  return { known: [...known], unknown: [...unknown] };
}

const RISK_ORDER: Record<"none" | Risk, number> = { none: 0, low: 1, medium: 2, high: 3 };

/** The highest risk among a set of capabilities (drives consent-dialog emphasis). */
export function maxRisk(caps: readonly Capability[]): "none" | Risk {
  let m: "none" | Risk = "none";
  for (const c of caps) {
    if (RISK_ORDER[CAPABILITY_INFO[c].risk] > RISK_ORDER[m]) m = CAPABILITY_INFO[c].risk;
  }
  return m;
}
