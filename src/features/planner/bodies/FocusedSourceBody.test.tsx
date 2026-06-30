import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/store";
import { defaultSourceConfig } from "../lib/sourceConfig";
import { SourceBody } from "./FocusedSourceBody";

// The body is store-backed (planSourceConfig keyed by projectId). Reset that slice between tests so
// each starts from an empty config.
//
// The native pre-built connector catalog was removed (#1976): there is no picker/search. Sources are
// proposed from the pitch (the ★ banner) and confirmed; each connector is a generic one-click token
// connector (agent-authored at runtime). These tests cover that surviving propose → declare → scan flow.
beforeEach(() => {
  useAppStore.setState({ planSourceConfig: {}, planningPitch: "" });
});

describe("SourceBody — empty state", () => {
  it("shows the read-only reassurance and no catalog when nothing is declared", () => {
    render(<SourceBody projectId="p1" />);
    expect(screen.getByText("Declare your sources")).toBeTruthy();
    expect(screen.getByText(/credentials never leave this device/i)).toBeTruthy();
    // The catalog picker is gone (#1976).
    expect(screen.queryByTestId("connector-catalog")).toBeNull();
  });
});

describe("SourceBody — planner-proposed", () => {
  it("confirming the proposed banner declares those sources", () => {
    useAppStore.getState().setPlanSourceConfig("p2", { ...defaultSourceConfig(), dataModelName: "Acme Core", proposed: ["quickbooks", "quickbase"] });
    render(<SourceBody projectId="p2" />);
    fireEvent.click(screen.getByTestId("proposed-confirm"));
    const cfg = useAppStore.getState().planSourceConfig.p2;
    expect(cfg.sources.map((s) => s.connectorId).sort()).toEqual(["quickbase", "quickbooks"]);
    expect(cfg.proposed).toEqual([]); // cleared once acted on
  });

  it("seeds the Confirm-N-sources banner from the planner pitch on first open (#1349)", async () => {
    // A fresh project (no stored source config) with a pitch that names two legacy systems.
    useAppStore.setState({ planningPitch: "Migrate off QuickBooks and Salesforce into one app." });
    render(<SourceBody projectId="pitch1" />);
    // The proposed-from-pitch ids land in the config → the banner surfaces with the right count …
    await waitFor(() => expect(screen.getByTestId("proposed-confirm").textContent).toMatch(/Confirm 2 sources/));
    expect(useAppStore.getState().planSourceConfig.pitch1.proposed.sort()).toEqual(["quickbooks", "salesforce"]);
    // … and confirming declares exactly those sources.
    fireEvent.click(screen.getByTestId("proposed-confirm"));
    expect(useAppStore.getState().planSourceConfig.pitch1.sources.map((s) => s.connectorId).sort()).toEqual(["quickbooks", "salesforce"]);
  });

  it("does not seed when the pitch names no known system", async () => {
    useAppStore.setState({ planningPitch: "A brand-new greenfield app with no legacy systems." });
    render(<SourceBody projectId="pitch2" />);
    // Nothing proposed → no banner; the empty-state prompt shows instead.
    await waitFor(() => expect(screen.getByText("Declare your sources")).toBeTruthy());
    expect(screen.queryByTestId("proposed-confirm")).toBeNull();
  });
});

describe("SourceBody — connect & scan", () => {
  it("connecting a declared source (one-click) scans it and surfaces the discovered inventory", async () => {
    useAppStore.getState().setPlanSourceConfig("p1", { ...defaultSourceConfig(), proposed: ["quickbase"] });
    render(<SourceBody projectId="p1" />);
    fireEvent.click(screen.getByTestId("proposed-confirm"));
    // A generic connector connects in one click (no per-vendor secret form); the card auto-expands.
    fireEvent.click(screen.getByTestId("connect-src-quickbase-1"));
    // connect → scanning → scanned surfaces the discovered inventory (card grid + aggregate ScanViews).
    await waitFor(() => expect(screen.getAllByText("Projects").length).toBeGreaterThan(0));
    const persisted = useAppStore.getState().planSourceConfig.p1.sources[0];
    expect(persisted.status).toBe("scanned");
  });

  it("readiness reaches all-connected once a declared source scans", async () => {
    useAppStore.getState().setPlanSourceConfig("p3", { ...defaultSourceConfig(), proposed: ["salesforce"] });
    render(<SourceBody projectId="p3" />);
    fireEvent.click(screen.getByTestId("proposed-confirm"));
    fireEvent.click(screen.getByTestId("connect-src-salesforce-1"));
    await waitFor(() => expect(screen.getByText(/sources connected/i)).toBeTruthy());
  });
});

describe("SourceBody — closes the data-dictates-structure loop (#1205)", () => {
  it("once every source is scanned, persists the derived model + shows the downstream-impact recap", async () => {
    useAppStore.getState().setPlanSourceConfig("p1", { ...defaultSourceConfig(), proposed: ["quickbase"] });
    render(<SourceBody projectId="p1" />);
    fireEvent.click(screen.getByTestId("proposed-confirm"));
    fireEvent.click(screen.getByTestId("connect-src-quickbase-1"));

    // The scanned-result visualizations appear once the source is scanned (gate met); their header
    // carries the downstream-impact recap …
    await waitFor(() => expect(screen.getByTestId("scan-views")).toBeTruthy());
    expect(screen.getByTestId("scan-views").textContent).toMatch(/seeds .* into features/i);
    // … and the derived model is persisted as the canonical artifact (refined, the user confirmed it).
    expect(vi.mocked(invoke)).toHaveBeenCalledWith(
      "data_persist_model",
      expect.objectContaining({ projectKey: "p1", refined: true }),
    );
  });
});
