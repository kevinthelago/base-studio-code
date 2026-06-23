import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { useAppStore } from "../../../store";
import { defaultSourceConfig } from "../shared/sourceConfig";
import { FocusedSourceBody } from "./FocusedSourceBody";

// The body is store-backed (planSourceConfig keyed by projectId). Reset that slice between tests so
// each starts from an empty config.
beforeEach(() => {
  useAppStore.setState({ planSourceConfig: {} });
});

describe("FocusedSourceBody — catalog → declare", () => {
  it("shows the connector catalog and read-only reassurance when nothing is declared", () => {
    render(<FocusedSourceBody projectId="p1" />);
    expect(screen.getByTestId("connector-catalog")).toBeTruthy();
    expect(screen.getByTestId("connector-tile-quickbase")).toBeTruthy();
    expect(screen.getByText(/Credentials stay on this device/i)).toBeTruthy();
  });

  it("declaring a connector adds its card and collapses the catalog into a chip-bar", () => {
    render(<FocusedSourceBody projectId="p1" />);
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
    render(<FocusedSourceBody projectId="p1" />);
    fireEvent.change(screen.getByPlaceholderText("Search connectors…"), { target: { value: "salesforce" } });
    expect(screen.getByTestId("connector-tile-salesforce")).toBeTruthy();
    expect(screen.queryByTestId("connector-tile-quickbase")).toBeNull();
  });
});

describe("FocusedSourceBody — spec-driven connect (token)", () => {
  it("requires the realm + secret, then connects → scans → shows discovered objects", async () => {
    render(<FocusedSourceBody projectId="p1" />);
    fireEvent.click(screen.getByTestId("connector-tile-quickbase"));

    const connectBtn = screen.getByRole("button", { name: /save & connect/i }) as HTMLButtonElement;
    expect(connectBtn.disabled).toBe(true); // fields empty

    fireEvent.change(screen.getByPlaceholderText("acme.quickbase.com"), { target: { value: "acme.quickbase.com" } });
    fireEvent.change(screen.getByLabelText("User Token"), { target: { value: "b2a7c91f" } });
    expect((screen.getByRole("button", { name: /save & connect/i }) as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: /save & connect/i }));

    // The simulated connect → scanning → scanned surfaces the discovered inventory.
    await waitFor(() => expect(screen.getByText("Projects")).toBeTruthy());
    expect(screen.getByText(/feeds the «your Data Model» Data Model/)).toBeTruthy();
    // The secret value is NEVER persisted into the config.
    const persisted = useAppStore.getState().planSourceConfig.p1.sources[0];
    expect(persisted.status).toBe("scanned");
    expect(JSON.stringify(persisted)).not.toContain("b2a7c91f");
  });

  it("reveal toggles the secret field between password and text", () => {
    render(<FocusedSourceBody projectId="p1" />);
    fireEvent.click(screen.getByTestId("connector-tile-quickbase"));
    const secret = screen.getByLabelText("User Token") as HTMLInputElement;
    expect(secret.type).toBe("password");
    fireEvent.click(screen.getByRole("button", { name: /reveal user token/i }));
    expect((screen.getByLabelText("User Token") as HTMLInputElement).type).toBe("text");
  });
});

describe("FocusedSourceBody — planner-proposed", () => {
  it("confirming the proposed banner declares those sources", () => {
    useAppStore.getState().setPlanSourceConfig("p2", { ...defaultSourceConfig(), dataModelName: "Acme Core", proposed: ["quickbooks", "quickbase"] });
    render(<FocusedSourceBody projectId="p2" />);
    fireEvent.click(screen.getByTestId("proposed-confirm"));
    const cfg = useAppStore.getState().planSourceConfig.p2;
    expect(cfg.sources.map((s) => s.connectorId).sort()).toEqual(["quickbase", "quickbooks"]);
    expect(cfg.proposed).toEqual([]); // cleared once acted on
  });
});

describe("FocusedSourceBody — readiness", () => {
  it("readiness reaches all-connected once an OAuth source scans", async () => {
    render(<FocusedSourceBody projectId="p3" />);
    fireEvent.click(screen.getByTestId("connector-tile-salesforce"));
    // OAuth connectors connect with one click (no secret form).
    fireEvent.click(screen.getByRole("button", { name: /connect to salesforce/i }));
    await waitFor(() => expect(within(screen.getByTestId("source-readiness")).getByText(/1 of 1 connected/)).toBeTruthy());
  });
});
