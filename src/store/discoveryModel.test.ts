// `discovery-chooses-the-model` — the PROJECT's level of the model precedence chain.
//
// The chain, nearest first:
//     a fleet stream's own model  (bsc plan fleet model)
//       > a team placement's      (bsc teams model)          the NODE
//       > the project's own       (bsc plan classify.model)  DISCOVERY
//       > the persona's default   (bsc persona model)
//       > the harness's own default (no --model at all)
//
// Every one of these is tested as a SEPARATION rather than in isolation: a level only means anything
// relative to the ones on either side of it, and a test that sets one level with the others empty
// passes for a chain assembled in any order.
import { describe, it, expect, beforeEach } from "vitest";
import { useAppStore } from "./";
import type { AgentStream, FleetPlan } from "@/features/planner/fleet/planFleet";
import type { Persona } from "@/features/personas";
import { sanitizeProjectKey } from "@/shared/lib/core/projectPaths";

const NAME = "discovery-model-test";
const KEY = sanitizeProjectKey(NAME);
const HUB = "/home/user/.base-studio-code/projects/discovery-model-test";
const PANE = `${KEY}:curator`;

const fleet = (streams: AgentStream[]): FleetPlan => ({ recommended: 1, reasoning: "t", streams, director: { enabled: false } });
const persona: Persona = { id: "persona-curator", name: "Curator", blurb: "", role: "curator", startPrompt: "curate", skills: [] };
const stream: AgentStream = { id: "curator", name: "Curator", repo: "", owns: [], issues: [], dependsOn: [], persona: "persona-curator" };

/** Seat the store with one persona and one project classification, then launch. */
function launch(opts: { personaModel?: string; projectModel?: string; streamModel?: string }) {
  useAppStore.setState({
    tabs: [], bscBaseDir: "/home/user/.base-studio-code", fleetPaneStreams: {}, paneModels: {},
    paneProviders: {},
    personas: [{ ...persona, ...(opts.personaModel ? { model: opts.personaModel } : {}) }],
    planClassification: opts.projectModel ? { [KEY]: { model: opts.projectModel } } : {},
  });
  useAppStore.getState().fleetStartProject(
    NAME,
    fleet([{ ...stream, ...(opts.streamModel ? { model: opts.streamModel } : {}) }]),
    KEY,
    { hubPath: HUB },
  );
  return useAppStore.getState();
}

describe("the project's discovery model", () => {
  beforeEach(() => {
    useAppStore.setState({ tabs: [], bscBaseDir: "/home/user/.base-studio-code", fleetPaneStreams: {}, personas: [persona], planClassification: {} });
  });

  it("beats the persona's default — a global identity is further away than this project", () => {
    // THE BITE. Before this, `classify.model` reached no launch at all: the architect could record the
    // decision and every session went on resolving `sess.model ?? persona.model`, so the project ran
    // on the persona's tier while the classification said otherwise. A recorded decision that changes
    // nothing is worse than an absent one — it reads as settled.
    expect(launch({ personaModel: "opus-4.5", projectModel: "haiku-4.5" }).paneModels[PANE]).toBe("haiku-4.5");
  });

  it("LOSES to the stream's own model, which already carries the node's placement", () => {
    // The nearer pair. `teamRoleStreams` puts a team placement's model on the stream, so beating
    // `sess.model` here would make a per-NODE choice unreachable — the thing
    // `a-node-cannot-carry-a-local-model` had just finished making possible.
    expect(launch({ personaModel: "opus-4.5", projectModel: "haiku-4.5", streamModel: "sonnet-4.5" }).paneModels[PANE])
      .toBe("sonnet-4.5");
  });

  it("applies when the persona has no default of its own", () => {
    expect(launch({ projectModel: "haiku-4.5" }).paneModels[PANE]).toBe("haiku-4.5");
  });

  it("falls through to the persona when the project made no choice", () => {
    // Non-regression for every project classified before this axis existed: an absent project model
    // must be indistinguishable from the axis not existing.
    expect(launch({ personaModel: "opus-4.5" }).paneModels[PANE]).toBe("opus-4.5");
  });

  it("leaves the pane with NO model when no level names one", () => {
    // An entry here would be the app choosing a tier on the user's behalf; the harness's own default
    // is what "nobody decided" has to mean.
    expect(launch({}).paneModels[PANE]).toBeUndefined();
  });

  it("routes the whole project to bsc-agent when discovery chose a LOCAL model", () => {
    // The point of the axis for today's work: ONE write moves a project onto the local runtime,
    // rather than one write per node. Asserting only `paneModels` would pass with the session still
    // launching Claude Code.
    const s = launch({ personaModel: "opus-4.5", projectModel: "qwen3.5:35b-a3b" });
    expect(s.paneModels[PANE]).toBe("qwen3.5:35b-a3b");
    expect(s.paneProviders[PANE]).toBe("bsc-agent");
  });

  it("lets ONE node stay on Claude inside a locally-classified project", () => {
    // The direction that proves the levels are ordered rather than merged: the project says local,
    // the stream (a node's placement, carried by `teamRoleStreams`) says a tier, and the tier wins.
    const s = launch({ projectModel: "qwen3.5:35b-a3b", streamModel: "opus-4.5" });
    expect(s.paneModels[PANE]).toBe("opus-4.5");
    expect(s.paneProviders[PANE]).not.toBe("bsc-agent");
  });
});
