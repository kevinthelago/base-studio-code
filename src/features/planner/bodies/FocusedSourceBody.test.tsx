import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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

describe("SourceBody — agent-authored runtime connectors (#1980)", () => {
  // Restore the default invoke mock (setup.ts resolves null) after each runtime-list test so the
  // overridden implementation doesn't leak into other suites.
  afterEach(() => {
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockResolvedValue(null);
  });

  it("resolves a declared source to its polled agent-authored connector label", async () => {
    // The pane polls `data_runtime_connectors`; feed it one agent-authored connector.
    vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
      // Connectors now come via the `bsc` bridge (#2130): `bsc data connector list` → full preset JSON.
      if (cmd === "bsc" && (args as { args?: string[] } | undefined)?.args?.includes("connector")) {
        return JSON.stringify([{ id: "acme-crm", label: "Acme CRM", category: "crm", auth: "token" }]);
      }
      return null;
    });
    useAppStore.getState().setPlanSourceConfig("p-rt", {
      ...defaultSourceConfig(),
      sources: [{ uid: "u1", connectorId: "acme-crm", status: "declared", fields: {} }],
    });
    render(<SourceBody projectId="p-rt" />);
    // Before the poll resolves the source would render its raw id ("acme-crm"); once the list feeds
    // in, the chip + card header resolve to the real label.
    await waitFor(() => expect(screen.getAllByText(/Acme CRM/).length).toBeGreaterThan(0));
  });
});

describe("SourceBody — closes the data-dictates-structure loop (#1205) via the mapping gate (#1986)", () => {
  it("shows the scan-views + mapping list once scanned, but only persists AFTER the user confirms the mapping", async () => {
    useAppStore.getState().setPlanSourceConfig("p1", { ...defaultSourceConfig(), proposed: ["quickbase"] });
    render(<SourceBody projectId="p1" />);
    fireEvent.click(screen.getByTestId("proposed-confirm"));
    fireEvent.click(screen.getByTestId("connect-src-quickbase-1"));

    // The scanned-result visualizations appear once the source is scanned (gate met); their header
    // carries the downstream-impact recap …
    await waitFor(() => expect(screen.getByTestId("scan-views")).toBeTruthy());
    expect(screen.getByTestId("scan-views").textContent).toMatch(/seeds .* into features/i);
    // … and the inferred source→canonical mapping list renders for confirmation.
    expect(screen.getByTestId("mapping-confirm")).toBeTruthy();
    // The model is NOT persisted yet — the human mapping gate (#1986) replaced the old auto-persist.
    // Persist now routes through the `bsc` bridge (#2114): `bsc data model set --refined` (model on stdin).
    expect(vi.mocked(invoke)).not.toHaveBeenCalledWith(
      "bsc",
      expect.objectContaining({ args: ["data", "model", "set", "--refined"] }),
    );

    // Confirming the mapping persists the derived model as the canonical artifact (refined).
    fireEvent.click(screen.getByTestId("confirm-mapping"));
    await waitFor(() => expect(vi.mocked(invoke)).toHaveBeenCalledWith(
      "bsc",
      expect.objectContaining({ projectKey: "p1", args: ["data", "model", "set", "--refined"] }),
    ));
    expect(screen.getByTestId("mapping-confirmed")).toBeTruthy();
  });
});

describe("SourceBody — ① declare a source (#1986)", () => {
  it("submitting the add-source input stages a source + injects the build-integration nudge", () => {
    const onInject = vi.fn();
    render(<SourceBody projectId="decl" onInject={onInject} />);
    fireEvent.change(screen.getByTestId("add-source-name"), { target: { value: "Stripe" } });
    fireEvent.change(screen.getByTestId("add-source-url"), { target: { value: "https://api.stripe.com" } });
    fireEvent.submit(screen.getByTestId("add-source"));

    // A declared source is staged under a slug id derived from the name.
    const cfg = useAppStore.getState().planSourceConfig.decl;
    expect(cfg.sources.map((s) => s.connectorId)).toEqual(["stripe"]);
    expect(cfg.sources[0].status).toBe("declared");
    // The planner is nudged to author the connector via the dev-loop, carrying the system name + url.
    expect(onInject).toHaveBeenCalledTimes(1);
    expect(onInject.mock.calls[0][0]).toContain("Stripe");
    expect(onInject.mock.calls[0][0]).toMatch(/build-integration|bsc data connector/);
  });

  it("does not stage anything for a blank name", () => {
    const onInject = vi.fn();
    render(<SourceBody projectId="decl2" onInject={onInject} />);
    fireEvent.submit(screen.getByTestId("add-source"));
    expect(useAppStore.getState().planSourceConfig.decl2?.sources ?? []).toHaveLength(0);
    expect(onInject).not.toHaveBeenCalled();
  });
});

describe("SourceBody — ② build status (#1986)", () => {
  afterEach(() => {
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockResolvedValue(null);
  });

  it("a declared source whose connector is not yet in the runtime list shows 'building…'", () => {
    useAppStore.getState().setPlanSourceConfig("p-b", {
      ...defaultSourceConfig(),
      sources: [{ uid: "u1", connectorId: "acme-crm", status: "declared", fields: {} }],
    });
    render(<SourceBody projectId="p-b" />);
    expect(screen.getByTestId("build-status-u1").textContent).toMatch(/building/i);
  });

  it("once the connector appears in the runtime list the source reads 'ready to connect'", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
      // Connectors now come via the `bsc` bridge (#2130): `bsc data connector list` → full preset JSON.
      if (cmd === "bsc" && (args as { args?: string[] } | undefined)?.args?.includes("connector")) {
        return JSON.stringify([{ id: "acme-crm", label: "Acme CRM", category: "crm", auth: "token" }]);
      }
      return null;
    });
    useAppStore.getState().setPlanSourceConfig("p-r", {
      ...defaultSourceConfig(),
      sources: [{ uid: "u1", connectorId: "acme-crm", status: "declared", fields: {} }],
    });
    render(<SourceBody projectId="p-r" />);
    await waitFor(() => expect(screen.getByTestId("build-status-u1").textContent).toMatch(/ready to connect/i));
  });
});
