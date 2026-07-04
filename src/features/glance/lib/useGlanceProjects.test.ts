import { describe, it, expect, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useGlanceProjects } from "./useGlanceProjects";
import { useAppStore } from "@/store";

describe("useGlanceProjects — declared role/status (#2284)", () => {
  beforeEach(() => useAppStore.setState({ localDraftProjects: {}, planFleet: {}, projectKeyAlias: {}, githubToken: "" }));

  it("passes through a draft's DECLARED role + status (curated coloring wins)", () => {
    useAppStore.setState({
      localDraftProjects: { "billing-svc": { title: "billing-svc", pitch: "", createdAt: 1, role: "service", status: "building" } },
    });
    const { result } = renderHook(() => useGlanceProjects());
    expect(result.current.find((p) => p.id === "billing-svc")).toMatchObject({ role: "service", status: "building" });
  });

  it("derives status when NOT declared (idle, or planning when the project has a fleet) and leaves role undeclared", () => {
    useAppStore.setState({
      localDraftProjects: {
        plain: { title: "Plain", pitch: "", createdAt: 1 },
        fleeted: { title: "Fleeted", pitch: "", createdAt: 2 },
      },
      planFleet: {
        fleeted: {
          recommended: 1, reasoning: "",
          streams: [{ id: "s", name: "S", repo: "o/r", owns: [], issues: [], dependsOn: [] }],
          director: { enabled: false },
        } as never,
      },
    });
    const { result } = renderHook(() => useGlanceProjects());
    const plain = result.current.find((p) => p.id === "plain");
    const fleeted = result.current.find((p) => p.id === "fleeted");
    expect(plain).toMatchObject({ status: "idle" });
    expect(plain?.role).toBeUndefined(); // derived downstream in buildGlanceData (hash), not here
    expect(fleeted).toMatchObject({ status: "planning" });
  });
});
