import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, beforeEach } from "vitest";
import { FocusedIntegrationsBody } from "./FocusedIntegrationsBody";
import { useAppStore } from "@/store";

beforeEach(() => {
  useAppStore.setState({ planSections: {}, planSourceConfig: {}, mcpServers: [] });
});

describe("FocusedIntegrationsBody (#1200)", () => {
  it("shows the empty state when the plan implies no integrations", () => {
    render(<FocusedIntegrationsBody projectId="p1" />);
    expect(screen.getByTestId("integrations-empty")).toBeTruthy();
  });

  it("surfaces an implied MCP server and connector from the plan text", () => {
    useAppStore.setState({ planSections: { p1: { stack: "Node + PostgreSQL", features: "Sync from Salesforce" } } });
    render(<FocusedIntegrationsBody projectId="p1" />);
    expect(screen.getByTestId("integrations-body")).toBeTruthy();
    expect(screen.getByTestId("integration-item-mcp:Postgres")).toBeTruthy();
    expect(screen.getByTestId("integration-item-connector:salesforce")).toBeTruthy();
  });

  it("assigning an available MCP server scopes it to the project (add without leaving)", () => {
    useAppStore.setState({ planSections: { p1: { stack: "Billing handled by Stripe" } } });
    render(<FocusedIntegrationsBody projectId="p1" />);
    fireEvent.click(screen.getByTestId("integration-assign-Stripe"));
    const servers = useAppStore.getState().mcpServers;
    expect(servers.some((s) => s.name === "Stripe" && s.projects.includes("p1"))).toBe(true);
  });

  it("adding a connector queues it for the Source stage (proposed)", () => {
    useAppStore.setState({ planSections: { p1: { features: "Read from HubSpot" } } });
    render(<FocusedIntegrationsBody projectId="p1" />);
    fireEvent.click(screen.getByTestId("integration-declare-hubspot"));
    expect(useAppStore.getState().planSourceConfig.p1.proposed).toContain("hubspot");
  });
});
