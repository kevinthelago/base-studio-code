// The choices a user makes from a pane's menus reach session.db, where the launch reads them over its own
// derivation (frontend-state-3-the-store-stops-restating-pane-wiring).
//
// This is a MIGRATION, not a removal: every setter still updates its store map, and these tests pin both
// halves. What they assert on the Rust side is the exact `bsc session choose` argv — a call-site that merely
// "calls bsc" would pass while writing the wrong key.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/store";

type BscPayload = { projectKey: unknown; args: string[] };

const chooseCalls = (): BscPayload[] =>
  vi.mocked(invoke).mock.calls
    .filter(([cmd, payload]) => cmd === "bsc" && (payload as BscPayload | undefined)?.args?.[1] === "choose")
    .map(([, payload]) => payload as BscPayload);

beforeEach(() => {
  vi.mocked(invoke).mockClear();
  useAppStore.setState({ paneModels: {}, paneProviders: {}, paneProfiles: {}, panePersonas: {} } as never);
});

describe("a pane choice is recorded where Rust reads it", () => {
  it("records the model the user picks, and still updates the map", async () => {
    useAppStore.getState().setPaneModel("proj:api", "opus-4.5" as never);
    await vi.waitFor(() => expect(chooseCalls()).toHaveLength(1));
    expect(chooseCalls()[0]).toEqual({
      projectKey: null,
      args: ["session", "choose", "proj:api", "--model", "opus-4.5", "--by", "app"],
    });
    expect(useAppStore.getState().paneModels["proj:api"]).toBe("opus-4.5");
  });

  it("records the harness the user puts a pane on", async () => {
    useAppStore.getState().setPaneProvider("proj:api", "bsc-agent");
    await vi.waitFor(() => expect(chooseCalls()).toHaveLength(1));
    expect(chooseCalls()[0].args).toEqual(["session", "choose", "proj:api", "--provider", "bsc-agent", "--by", "app"]);
    expect(useAppStore.getState().paneProviders["proj:api"]).toBe("bsc-agent");
  });

  it("records a profile, the cleared no-profile state, and a return to the derived one as three different writes", async () => {
    const { setPaneProfile } = useAppStore.getState();
    setPaneProfile("proj:director", "pf_review");
    setPaneProfile("proj:director", "");
    setPaneProfile("proj:director", null);
    await vi.waitFor(() => expect(chooseCalls()).toHaveLength(3));
    expect(chooseCalls().map((c) => c.args.slice(3, -2))).toEqual([["--profile", "pf_review"], ["--no-profile"], ["--clear", "profile"]]);
    expect(useAppStore.getState().paneProfiles).not.toHaveProperty("proj:director");
  });

  it("keeps an empty profile in the map as the cleared state", () => {
    useAppStore.getState().setPaneProfile("proj:director", "");
    expect(useAppStore.getState().paneProfiles["proj:director"]).toBe("");
  });

  it("records the persona a user adopts for a pane", async () => {
    useAppStore.setState({
      personas: [{ id: "persona-architect", name: "Architect", role: "architect", model: "opus-4.5", startPrompt: "" }],
    } as never);
    useAppStore.getState().applyPersonaToPane("proj:director", "persona-architect");
    await vi.waitFor(() => expect(chooseCalls()).toHaveLength(1));
    expect(chooseCalls()[0].args).toEqual(["session", "choose", "proj:director", "--persona", "persona-architect", "--by", "app"]);
    expect(useAppStore.getState().panePersonas["proj:director"]).toBe("persona-architect");
  });

  it("records nothing when the persona is not in the library", () => {
    useAppStore.setState({ personas: [] } as never);
    useAppStore.getState().applyPersonaToPane("proj:director", "persona-gone");
    expect(chooseCalls()).toHaveLength(0);
  });
});
