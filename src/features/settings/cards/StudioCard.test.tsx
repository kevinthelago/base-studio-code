import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// Mock the bsc bridge + the studio gist-share so the card's actions are observable without a backend.
const { bsc, bscJson, bscWrite, exportStudioToGist, importStudioFromGist } = vi.hoisted(() => ({
  bsc: vi.fn(), bscJson: vi.fn(), bscWrite: vi.fn(), exportStudioToGist: vi.fn(), importStudioFromGist: vi.fn(),
}));
vi.mock("@/shared/lib/core/bsc", () => ({ bsc, bscJson, bscWrite }));
vi.mock("@/features/studio", () => ({ exportStudioToGist, importStudioFromGist }));
// Isolate the card from the full store (the card only reads `githubToken`) — avoids the store's async
// persist-rehydration firing during the test. No token → upload is gated, matching the assertions.
vi.mock("@/store", () => ({ useAppStore: (sel: (s: { githubToken: string }) => unknown) => sel({ githubToken: "" }) }));

import { StudioCard } from "./StudioCard";

describe("StudioCard (#2892)", () => {
  beforeEach(() => {
    bsc.mockReset().mockResolvedValue("{}");
    bscJson.mockReset().mockResolvedValue([]);
    bscWrite.mockReset().mockResolvedValue(undefined);
    exportStudioToGist.mockReset();
    importStudioFromGist.mockReset();
  });

  it("renders the save + import affordances", () => {
    render(<StudioCard />);
    expect(screen.getByText("Studios")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save current state" })).toBeInTheDocument();
    expect(screen.getByLabelText("Studio gist URL or id")).toBeInTheDocument();
  });

  it("saves the current state as a named studio via `bsc studio save`, then refreshes the list", async () => {
    render(<StudioCard />);
    fireEvent.change(screen.getByLabelText("Studio name"), { target: { value: "My studio" } });
    fireEvent.click(screen.getByRole("button", { name: "Save current state" }));
    await waitFor(() => expect(bsc).toHaveBeenCalledWith(null, ["studio", "save", "My studio"]));
    // a save re-lists the store
    expect(bscJson).toHaveBeenCalledWith(null, ["studio", "list"], []);
  });

  it("lists saved studios and gates upload on a GitHub token", async () => {
    bscJson.mockResolvedValue([{ id: "web", name: "Web App Dev" }]);
    render(<StudioCard />);
    await waitFor(() => expect(screen.getByText("Web App Dev")).toBeInTheDocument());
    // no token in the test store → upload is disabled
    expect(screen.getByRole("button", { name: "Upload to gist" })).toBeDisabled();
  });

  it("imports a studio from a gist and writes it back via `bsc studio set`", async () => {
    importStudioFromGist.mockResolvedValue({ ok: true, studio: { id: "x", name: "Shared", snapshot: {} } });
    render(<StudioCard />);
    fireEvent.change(screen.getByLabelText("Studio gist URL or id"), { target: { value: "https://gist.github.com/u/abc" } });
    fireEvent.click(screen.getByRole("button", { name: "Import from gist" }));
    await waitFor(() => expect(importStudioFromGist).toHaveBeenCalledWith("https://gist.github.com/u/abc", ""));
    expect(bscWrite).toHaveBeenCalledWith(null, ["studio", "set"], { id: "x", name: "Shared", snapshot: {} });
  });
});
