import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/store";
import { defaultSourceConfig, newDeclaredSource, type SourceConfig } from "../lib/sourceConfig";
import { useSourceConnection } from "./sourceConnection";

// The hook is store-backed (planSourceConfig keyed by projectId). patchSource reads the latest
// config from the store, so persist must actually write it back. Reset the slice between tests.
beforeEach(() => {
  vi.mocked(invoke).mockReset().mockResolvedValue(null);
  useAppStore.setState({ planSourceConfig: {} });
});

/** Render the hook against a project key, seeding the store with `cfg` and wiring a real persist. */
function renderConnection(pid: string, cfg: SourceConfig) {
  useAppStore.getState().setPlanSourceConfig(pid, cfg);
  return renderHook(() =>
    useSourceConnection(pid, cfg, (next) => useAppStore.getState().setPlanSourceConfig(pid, next)),
  );
}

describe("useSourceConnection — credential connect lifecycle", () => {
  it("connect() drives declared → connecting → scanning → scanned and saves the secret to the keychain", async () => {
    const src = newDeclaredSource("quickbase", "src-quickbase-1");
    const cfg: SourceConfig = { ...defaultSourceConfig(), sources: [src] };
    const { result } = renderConnection("p1", cfg);

    // Stage a secret in local (un-persisted) state, then connect.
    act(() => { result.current.setSecret("src-quickbase-1", "userToken", "tok-123"); });
    act(() => { result.current.connect("src-quickbase-1"); });

    // The lifecycle ends at scanned with the sample-shape inventory (invoke mock returns null →
    // non-live → fallback).
    await waitFor(() => {
      const persisted = useAppStore.getState().planSourceConfig.p1.sources[0];
      expect(persisted.status).toBe("scanned");
    });

    // The secret was saved to the device keychain …
    expect(vi.mocked(invoke)).toHaveBeenCalledWith(
      "source_save_secret",
      expect.objectContaining({ project: "p1", sourceUid: "src-quickbase-1", field: "userToken", value: "tok-123" }),
    );
    // … and is NEVER written into the persisted config.
    const persisted = useAppStore.getState().planSourceConfig.p1.sources[0];
    expect(JSON.stringify(persisted)).not.toContain("tok-123");
    expect((persisted.objects ?? []).length).toBeGreaterThan(0);
  });

  it("retry() resets an errored source back to declared", () => {
    const src = { ...newDeclaredSource("quickbase", "src-quickbase-2"), status: "error" as const, error: "boom" };
    const cfg: SourceConfig = { ...defaultSourceConfig(), sources: [src] };
    const { result } = renderConnection("p2", cfg);

    act(() => { result.current.retry("src-quickbase-2"); });

    const persisted = useAppStore.getState().planSourceConfig.p2.sources[0];
    expect(persisted.status).toBe("declared");
    expect(persisted.error).toBeUndefined();
  });

  it("toggleReveal() flips a source's reveal flag", () => {
    const cfg: SourceConfig = { ...defaultSourceConfig(), sources: [newDeclaredSource("quickbase", "u")] };
    const { result } = renderConnection("p3", cfg);

    expect(result.current.revealed.has("u")).toBe(false);
    act(() => { result.current.toggleReveal("u"); });
    expect(result.current.revealed.has("u")).toBe(true);
    act(() => { result.current.toggleReveal("u"); });
    expect(result.current.revealed.has("u")).toBe(false);
  });
});
