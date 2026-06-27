import { describe, it, expect, beforeEach } from "vitest";
import { useAppStore } from "./";
import type { FleetPlan } from "@/features/planner/fleet/planFleet";
import { directorPaneId, fleetPaneId, triagePaneId } from "@/app/console/lib/paneIdentity";
import { sanitizeProjectKey } from "@/shared/lib/core/projectPaths";

// Launch-time prompt delivery for the fleet + triage. The orphaned reference-context
// (assigned-knowledge) subsystem was removed (#1812 — dead since #1460, superseded by
// research + skills), so a launched session is seeded ONLY by its kickoff/triage
// startup prompt + the still-live startup-prompt-doc cascade — NOTHING from reference
// context. These tests lock that in: the startup-prompt wiring still flows, and the
// removed `paneReferenceDocs` field is never reintroduced.
//
// Panes are keyed by their STABLE identity id (#1176): director ⇒ <key>:director,
// worker ⇒ <key>:<streamId>, triage ⇒ <key>:<repo>:triage.

const fleet: FleetPlan = {
  recommended: 2,
  reasoning: "r",
  director: { enabled: true, role: "integrator" },
  streams: [
    { id: "auth-ui", name: "Auth UI", repo: "own/web", owns: ["src/auth/**"], issues: [], dependsOn: [], prompt: "prompts/auth-ui-kickoff.md" },
    { id: "api", name: "API", repo: "own/api", owns: [], issues: [], dependsOn: [] },
  ],
};

beforeEach(() => {
  useAppStore.setState({
    tabs: [],
    activeTabIdx: 0,
    bscBaseDir: "/base",
    // Reset the pane prompt maps so text/doc assignments don't leak between tests
    // (the store is a shared singleton; beforeEach only resets named fields).
    paneStartupPromptText: {},
    paneStartupPromptDocs: {},
    defaultStartupPromptDoc: null,
    projectStartupPromptDoc: {},
    repoStartupPromptDoc: {},
    repoTriagePromptDoc: {},
  });
});

describe("fleetStartProject — startup-prompt delivery, no reference context", () => {
  it("seeds the director kickoff doc and each worker's kickoff/stream prompt", () => {
    useAppStore.getState().fleetStartProject("Proj", fleet, "proj-key");
    const st = useAppStore.getState();
    // Director → its planner-authored kickoff doc.
    expect(st.paneStartupPromptDocs[directorPaneId("proj-key")]).toContain("director-kickoff.md");
    // Worker with an authored kickoff → that doc.
    expect(st.paneStartupPromptDocs[fleetPaneId("proj-key", "auth-ui")]).toContain("auth-ui-kickoff.md");
    // Worker without one → the generated stream prompt text.
    const apiPrompt = st.paneStartupPromptText[fleetPaneId("proj-key", "api")];
    expect(apiPrompt).toBeTruthy();
    expect(apiPrompt).toContain("API");
  });

  it("injects NO reference context — the removed paneReferenceDocs field is gone", () => {
    useAppStore.getState().fleetStartProject("Proj", fleet, "proj-key");
    const st = useAppStore.getState() as unknown as Record<string, unknown>;
    expect("paneReferenceDocs" in st).toBe(false);
  });
});

describe("triageStartProject — startup-prompt delivery, no reference context", () => {
  it("seeds the verbatim triage prompt and the startup-prompt-doc fallback", () => {
    useAppStore.setState({ defaultStartupPromptDoc: "documents/kickoff.md" });
    useAppStore.getState().triageStartProject("Proj", ["own/web"]);
    const st = useAppStore.getState();
    const pane = triagePaneId(sanitizeProjectKey("Proj"), "own/web");
    // The verbatim triage prompt is delivered as the launch text…
    expect(st.paneStartupPromptText[pane]).toBeTruthy();
    // …with the resolved startup-prompt-doc as the doc fallback (still wired).
    expect(st.paneStartupPromptDocs[pane]).toBe("documents/kickoff.md");
  });

  it("prefers an assigned per-repo triage doc over the verbatim prompt", () => {
    useAppStore.setState({ repoTriagePromptDoc: { "Proj::own/web": "documents/web-triage.md" } });
    useAppStore.getState().triageStartProject("Proj", ["own/web"], "Proj");
    const st = useAppStore.getState();
    const pane = triagePaneId(sanitizeProjectKey("Proj"), "own/web");
    expect(st.paneStartupPromptDocs[pane]).toBe("documents/web-triage.md");
    // No verbatim text override when a triage doc wins.
    expect(st.paneStartupPromptText[pane]).toBeUndefined();
  });

  it("injects NO reference context — the removed paneReferenceDocs field is gone", () => {
    useAppStore.getState().triageStartProject("Proj", ["own/web"]);
    const st = useAppStore.getState() as unknown as Record<string, unknown>;
    expect("paneReferenceDocs" in st).toBe(false);
  });
});
