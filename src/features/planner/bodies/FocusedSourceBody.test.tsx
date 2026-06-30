import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/store";
import { defaultSourceConfig } from "../lib/sourceConfig";
import { SourceBody } from "./FocusedSourceBody";

// The body is store-backed (planSourceConfig keyed by projectId). Reset that slice between tests so
// each starts from an empty config.
beforeEach(() => {
  useAppStore.setState({ planSourceConfig: {}, planningPitch: "" });
});

describe("SourceBody — catalog → declare", () => {
  it("shows the connector catalog and read-only reassurance when nothing is declared", () => {
    render(<SourceBody projectId="p1" />);
    expect(screen.getByTestId("connector-catalog")).toBeTruthy();
    expect(screen.getByTestId("connector-tile-quickbase")).toBeTruthy();
    expect(screen.getByText(/credentials never leave this device/i)).toBeTruthy();
  });

  it("declaring a connector adds its card and collapses the catalog into a chip-bar", () => {
    render(<SourceBody projectId="p1" />);
    fireEvent.click(screen.getByTestId("connector-tile-quickbase"));
    // A card appears…
    expect(screen.getByTestId(/^source-card-/)).toBeTruthy();
    // …the chip-bar replaces the always-on catalog…
    expect(screen.getByTestId("source-chips")).toBeTruthy();
    expect(screen.queryByTestId("connector-catalog")).toBeNull();
    // …and the config was persisted to the store.
    expect(useAppStore.getState().planSourceConfig.p1.sources).toHaveLength(1);
  });

  it("search filters the catalog", () => {
    render(<SourceBody projectId="p1" />);
    fireEvent.change(screen.getByPlaceholderText("Search connectors…"), { target: { value: "salesforce" } });
    expect(screen.getByTestId("connector-tile-salesforce")).toBeTruthy();
    expect(screen.queryByTestId("connector-tile-quickbase")).toBeNull();
  });
});

describe("SourceBody — spec-driven connect (token)", () => {
  it("requires the realm + secret, then connects → scans → shows discovered objects", async () => {
    render(<SourceBody projectId="p1" />);
    fireEvent.click(screen.getByTestId("connector-tile-quickbase"));

    const connectBtn = screen.getByRole("button", { name: /save & connect/i }) as HTMLButtonElement;
    expect(connectBtn.disabled).toBe(true); // fields empty

    fireEvent.change(screen.getByPlaceholderText("acme.quickbase.com"), { target: { value: "acme.quickbase.com" } });
    fireEvent.change(screen.getByLabelText("User Token"), { target: { value: "b2a7c91f" } });
    expect((screen.getByRole("button", { name: /save & connect/i }) as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: /save & connect/i }));

    // The connect → scanning → scanned surfaces the discovered inventory (in the source card
    // grid and the aggregate ScanViews — so it can appear more than once).
    await waitFor(() => expect(screen.getAllByText("Projects").length).toBeGreaterThan(0));
    expect(screen.getByText(/feeds the «your Data Model» Data Model/)).toBeTruthy();
    // The secret value is NEVER persisted into the config.
    const persisted = useAppStore.getState().planSourceConfig.p1.sources[0];
    expect(persisted.status).toBe("scanned");
    expect(JSON.stringify(persisted)).not.toContain("b2a7c91f");
  });

  it("reveal toggles the secret field between password and text", () => {
    render(<SourceBody projectId="p1" />);
    fireEvent.click(screen.getByTestId("connector-tile-quickbase"));
    const secret = screen.getByLabelText("User Token") as HTMLInputElement;
    expect(secret.type).toBe("password");
    fireEvent.click(screen.getByRole("button", { name: /reveal user token/i }));
    expect((screen.getByLabelText("User Token") as HTMLInputElement).type).toBe("text");
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
    // Nothing proposed → no banner, the catalog shows instead.
    await waitFor(() => expect(screen.getByTestId("connector-catalog")).toBeTruthy());
    expect(screen.queryByTestId("proposed-confirm")).toBeNull();
  });
});

describe("SourceBody — readiness", () => {
  it("readiness reaches all-connected once an OAuth source scans", async () => {
    render(<SourceBody projectId="p3" />);
    fireEvent.click(screen.getByTestId("connector-tile-salesforce"));
    // OAuth connectors connect with one click (no secret form).
    fireEvent.click(screen.getByRole("button", { name: /connect to salesforce/i }));
    // The top banner flips to the all-connected state once the source scans (the bottom
    // readiness banner that duplicated this counter was removed).
    await waitFor(() => expect(screen.getByText(/sources connected/i)).toBeTruthy());
  });
});

describe("SourceBody — closes the data-dictates-structure loop (#1205)", () => {
  it("once every source is scanned, persists the derived model + shows the downstream-impact recap", async () => {
    render(<SourceBody projectId="p1" />);
    fireEvent.click(screen.getByTestId("connector-tile-quickbase"));
    fireEvent.change(screen.getByPlaceholderText("acme.quickbase.com"), { target: { value: "acme.quickbase.com" } });
    fireEvent.change(screen.getByLabelText("User Token"), { target: { value: "tok" } });
    fireEvent.click(screen.getByRole("button", { name: /save & connect/i }));

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
