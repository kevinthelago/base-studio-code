// projectPaneAgents -- maps fleet streams + agent profiles + flows into the
// ProjectPane `Agent` cards (posture, kickoff preview, lane scope). Extracted from
// projectPaneData (#2151); pure, no logic changes.

import type { Tier, ToolKey } from "@/features/agents";
import { resolveFlow } from "../fleet/agentFlow";
import { resolveStrategy } from "../lib/integrationStrategy";
import { depsForRepo } from "../issues/dependencies";
import { buildWorkerScope } from "../fleet/workerScope";
import { buildStreamPrompt } from "@/store/helpers";
import { resolveStreamPersona, personaStreamPrompt } from "../fleet/streamPersona";
import type { AgentProfile } from "@/features/agents";
import type { Posture, Perm, Agent } from "./projectPane.types";
import type { BuildProjectPaneInput } from "./projectPaneInput";

const AGENT_HUES = [230, 70, 50, 145, 195, 300, 350, 110, 20, 260];
function agentColor(index: number): string {
  const hue = AGENT_HUES[index % AGENT_HUES.length];
  return "oklch(0.74 0.13 " + hue + ")";
}

function initialFor(id: string): string {
  const m = id.match(/[a-z0-9]/i);
  return m ? m[0].toUpperCase() : "?";
}

function mapPush(push: string): string {
  return push === "auto-pr" ? "auto-PR" : push;
}

const DEFAULT_PERM: Perm = {
  read: "allow", edit: "ask", create: "ask", run: "ask", net: "deny", push: "ask", pkg: "deny",
};

function derivePerm(profile: AgentProfile | undefined, push: string): Perm {
  const tier = (k: ToolKey, fallback: Posture): Posture =>
    (profile?.tools?.[k] as Tier | undefined) ?? fallback;
  const pushPosture: Posture =
    push === "none" ? "deny" :
    push === "auto-pr" ? "allow" :
    "ask";
  if (!profile) {
    return { ...DEFAULT_PERM, push: pushPosture };
  }
  const net: Posture = profile.net.allow.length > 0 ? "allow"
    : (profile.tools?.web as Tier | undefined) ?? "deny";
  return {
    read:   tier("read", "ask"),
    edit:   tier("edit", "ask"),
    create: tier("write", "ask"),
    run:    tier("bash", "ask"),
    net,
    push:   pushPosture,
    pkg:    "deny",
  };
}

export function buildAgents(input: BuildProjectPaneInput): Agent[] {
  const streams = input.fleet?.streams ?? [];
  return streams.map((s, i) => {
    // The worker's posture is its ROLE's profile (Autonomous trusted), shown read-only — no
    // per-stream perm/preset overrides anymore. An explicit `s.profile` override still resolves.
    const profile = input.profiles.find(p => p.id === (s.profile ?? "pf_auto"));
    const flow = resolveFlow(s.flow);
    // #2053: compute the exact kickoff + lane context this stream will launch with, so the card can
    // preview them (pure — the same builders fleetStartProject / write_worker_context use).
    const strategy = resolveStrategy(s.strategy, input.fleet?.strategy);
    const scope = buildWorkerScope(s, depsForRepo(input.dependencies ?? [], s.repo), false, input.uiPairing);
    // #2094: a stream may launch AS a persona — its role + persona-identity kickoff drive the row +
    // preview (matching fleetStartProject). No persona ⇒ the plain worker role + kickoff.
    const persona = resolveStreamPersona(input.personas ?? [], s);
    return {
      id: s.id,
      name: s.name.startsWith("@") ? s.name : "@" + s.id,
      role: persona?.role ?? "worker",
      status: "idle",
      repo: s.repo,
      color: agentColor(i),
      initial: initialFor(s.id),
      owns: s.owns,
      issues: s.issues,
      preset: profile ? profile.name : "Autonomous (trusted)",
      perm: derivePerm(profile, flow.push),
      flow: { autonomy: flow.autonomy, push: mapPush(flow.push), gate: flow.gate },
      model: s.model,
      persona: s.persona,
      strategy: s.strategy,
      ctx: s.owns.length,
      kickoff: persona ? personaStreamPrompt(persona, s, strategy) : buildStreamPrompt(s, strategy),
      scope,
      authoredPrompt: s.prompt,
    };
  });
}
