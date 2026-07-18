// The whole-fleet ▶ Start all action lives in the graph TOOLBAR (#3348), next to zoom/fit — not the page
// header (its short-lived #3343 home). Shown only when drilled into a real project's fleet; absent on the
// un-drilled network and on the synthetic base-studio-code node (whose studio sessions launch on their own).
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { useAppStore } from "@/store";
import { GlanceWorkspace } from "./GlanceWorkspace";
import { BASE_STUDIO_PROJECT_ID } from "./lib/studioProject";

describe("GlanceWorkspace — whole-fleet ▶ Start all in the toolbar (#3348)", () => {
  beforeEach(() => {
    // One triaged project so the Network graph has a real node to drill into.
    useAppStore.setState({
      localDraftProjects: { proj: { title: "Proj", pitch: "", createdAt: 1 } },
      triagedProjects: { proj: 1 },
      projectLinks: [], glanceDrill: null,
    });
  });

  it("hides '▶ Start all' on the un-drilled network (the toolbar itself is present)", async () => {
    render(<GlanceWorkspace />);
    await waitFor(() => expect(screen.getByText("fit")).toBeTruthy()); // graph toolbar rendered
    expect(screen.queryByRole("button", { name: "▶ Start all" })).toBeNull();
  });

  it("shows '▶ Start all' in the toolbar when drilled into a real project's fleet", async () => {
    useAppStore.setState({ glanceDrill: "proj" });
    render(<GlanceWorkspace />);
    await waitFor(() => expect(screen.getByRole("button", { name: "▶ Start all" })).toBeTruthy());
  });

  it("hides '▶ Start all' on the synthetic base-studio-code node (studio sessions launch on their own)", async () => {
    useAppStore.setState({ glanceDrill: BASE_STUDIO_PROJECT_ID });
    render(<GlanceWorkspace />);
    await waitFor(() => expect(screen.getByText("fit")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "▶ Start all" })).toBeNull();
  });
});
