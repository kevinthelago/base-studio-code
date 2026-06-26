import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { useAppStore } from "@/store";
import { destinationDefined, syncDefined } from "../lib/integrationConfig";
import { FocusedDestinationBody, FocusedSyncBody } from "./IntegrationBodies";

beforeEach(() => useAppStore.setState({ planIntegrationConfig: {} }));

describe("FocusedDestinationBody (#1207)", () => {
  it("picking a type + target + write mode defines the destination", () => {
    render(<FocusedDestinationBody projectId="p1" />);
    expect(destinationDefined(useAppStore.getState().planIntegrationConfig.p1)).not.toBe(true);
    fireEvent.click(screen.getByTestId("dest-warehouse"));
    fireEvent.change(screen.getByPlaceholderText(/bigquery/i), { target: { value: "bigquery://acme.raw" } });
    fireEvent.click(screen.getByText("upsert"));
    expect(destinationDefined(useAppStore.getState().planIntegrationConfig.p1)).toBe(true);
  });
});

describe("FocusedSyncBody (#1207)", () => {
  it("full sync needs only mode + schedule; incremental reveals + requires a watermark", () => {
    render(<FocusedSyncBody projectId="p2" />);
    // full: no watermark field
    fireEvent.click(screen.getByText("full"));
    expect(screen.queryByText("watermark field")).not.toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText(/0 2/), { target: { value: "@hourly" } });
    expect(syncDefined(useAppStore.getState().planIntegrationConfig.p2)).toBe(true);

    // incremental: watermark field appears and is required
    fireEvent.click(screen.getByText("incremental"));
    expect(screen.getByText("watermark field")).toBeInTheDocument();
    expect(syncDefined(useAppStore.getState().planIntegrationConfig.p2)).toBe(false); // no watermark yet
    fireEvent.change(screen.getByPlaceholderText(/updated_at/), { target: { value: "updated_at" } });
    expect(syncDefined(useAppStore.getState().planIntegrationConfig.p2)).toBe(true);
  });
});
