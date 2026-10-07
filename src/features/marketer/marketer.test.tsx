import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MarketerWorkspace } from "./MarketerWorkspace";
import { useMarketerStore } from "./store";
import { useAppStore } from "@/store";
import { resetPageTabs } from "@/test/storeReset";

beforeEach(() => {
  resetPageTabs();
  useMarketerStore.setState({ campaigns: [], contentItems: [] });
  useAppStore.setState({
    mcpServers: [{ id: "c1", name: "Channel (mock)", enabled: false, projects: [], transport: "stdio", command: "bsc-channel-mock-mcp" }],
    activeProjectId: "proj-1",
  });
});

describe("MarketerWorkspace (wired to its own store)", () => {
  it("shows an empty state with no campaigns", () => {
    render(<MarketerWorkspace />);
    expect(screen.getByText("No campaigns yet")).toBeTruthy();
  });

  it("creates a campaign and a draft, then blocks approval until compliant", () => {
    render(<MarketerWorkspace />);
    fireEvent.click(screen.getByText("+ New campaign"));
    expect(useMarketerStore.getState().campaigns.length).toBe(1);

    fireEvent.click(screen.getByText("+ draft"));
    expect(useMarketerStore.getState().contentItems.length).toBe(1);

    // The drawer opens for the new draft; approve is disabled while the compliance gate fails
    // (email channel with an empty body — no unsubscribe link, no sender identity).
    const approveBtn = screen.getByText("approve") as HTMLButtonElement;
    expect(approveBtn.disabled).toBe(true);
    expect(screen.getByText(/unsubscribe link/i)).toBeTruthy();
  });

  it("approves a draft once it's compliant, then schedules and publishes it", async () => {
    render(<MarketerWorkspace />);
    fireEvent.click(screen.getByText("+ New campaign"));
    fireEvent.click(screen.getByText("+ draft"));

    const bodyField = screen.getByPlaceholderText("draft the content…") as HTMLTextAreaElement;
    fireEvent.change(bodyField, { target: { value: "Hello! Unsubscribe: /u" } });
    const senderField = screen.getByPlaceholderText("Acme Inc, 1 Main St") as HTMLInputElement;
    fireEvent.change(senderField, { target: { value: "Acme Inc, 1 Main St" } });

    const approveBtn = screen.getByText("approve") as HTMLButtonElement;
    expect(approveBtn.disabled).toBe(false);
    fireEvent.click(approveBtn);
    expect(useMarketerStore.getState().contentItems[0].status).toBe("approved");

    fireEvent.click(screen.getByText("publish now"));
    await waitFor(() => expect(useMarketerStore.getState().contentItems[0].status).toBe("published"));
    expect(useMarketerStore.getState().contentItems[0].receiptId).toBeTruthy();
  });

  it("switches to the Channels tab and shows the known channel", () => {
    render(<MarketerWorkspace />);
    fireEvent.click(screen.getByText("Channels"));
    expect(screen.getByText("Channel (mock)")).toBeTruthy();
  });

  it("switches to the Analytics tab and shows the rollup tiles", async () => {
    render(<MarketerWorkspace />);
    fireEvent.click(screen.getByText("Analytics"));
    expect(screen.getByText("published")).toBeTruthy();
    // AnalyticsView fetches each channel's metrics readout on mount; let that settle so the
    // resulting state update lands inside act() instead of after the test returns.
    await waitFor(() => expect(screen.getByText("no sends yet")).toBeTruthy());
  });
});
