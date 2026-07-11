import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// Mock the bsc bridge + the studio gist-share so the card's actions are observable without a backend.
const {
  bsc, bscJson, bscWrite, exportStudioToGist, importStudioFromGist,
  hydrateComponents, hydrateThemes, hydrateVariants, hydrateKitUsage, hydratePersonas, hydrateOrgs,
} = vi.hoisted(() => ({
  bsc: vi.fn(), bscJson: vi.fn(), bscWrite: vi.fn(), exportStudioToGist: vi.fn(), importStudioFromGist: vi.fn(),
  hydrateComponents: vi.fn(), hydrateThemes: vi.fn(), hydrateVariants: vi.fn(),
  hydrateKitUsage: vi.fn(), hydratePersonas: vi.fn(), hydrateOrgs: vi.fn(),
}));
vi.mock("@/shared/lib/core/bsc", () => ({ bsc, bscJson, bscWrite }));
vi.mock("@/features/studio", () => ({ exportStudioToGist, importStudioFromGist }));
// Isolate the card from the full store: the card reads `githubToken` via the selector form AND calls
// `useAppStore.getState().hydrate*()` after an apply, so the mock exposes both. No token → upload is
// gated, matching the assertions.
vi.mock("@/store", () => {
  const useAppStore = (sel: (s: { githubToken: string }) => unknown) => sel({ githubToken: "" });
  (useAppStore as unknown as { getState: () => unknown }).getState = () => ({
    hydrateComponents, hydrateThemes, hydrateVariants, hydrateKitUsage, hydratePersonas, hydrateOrgs,
  });
  return { useAppStore };
});

import { StudioCard } from "./StudioCard";

describe("StudioCard (#2892)", () => {
  beforeEach(() => {
    bsc.mockReset().mockResolvedValue("{}");
    bscJson.mockReset().mockResolvedValue([]);
    bscWrite.mockReset().mockResolvedValue(undefined);
    exportStudioToGist.mockReset();
    importStudioFromGist.mockReset();
    for (const h of [hydrateComponents, hydrateThemes, hydrateVariants, hydrateKitUsage, hydratePersonas, hydrateOrgs]) {
      h.mockReset().mockResolvedValue(undefined);
    }
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

  // #2893: Apply — re-seed the app's libraries from a saved studio, behind a confirm.
  const openApplyConfirm = async () => {
    bscJson.mockResolvedValue([{ id: "web", name: "Web App Dev" }]);
    render(<StudioCard />);
    await waitFor(() => expect(screen.getByText("Web App Dev")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(screen.getByText('Apply "Web App Dev"?')).toBeInTheDocument();
  };

  it("applies a saved studio after the confirm, then re-hydrates the libraries", async () => {
    await openApplyConfirm();
    fireEvent.click(screen.getByRole("button", { name: "apply" })); // the direct (no save-first) choice
    await waitFor(() => expect(bsc).toHaveBeenCalledWith(null, ["studio", "apply", "web"]));
    // a hydrate runs so the UI reflects the freshly re-seeded stores (no restart needed)
    expect(hydrateComponents).toHaveBeenCalled();
    expect(hydrateOrgs).toHaveBeenCalled();
    // the direct path does NOT snapshot the current state first
    expect(bsc).not.toHaveBeenCalledWith(null, ["studio", "save", "Before Web App Dev"]);
  });

  it("snapshots the current state BEFORE applying on the save-first path", async () => {
    await openApplyConfirm();
    fireEvent.click(screen.getByRole("button", { name: "save current first, then apply" }));
    await waitFor(() => expect(bsc).toHaveBeenCalledWith(null, ["studio", "apply", "web"]));
    expect(bsc).toHaveBeenCalledWith(null, ["studio", "save", "Before Web App Dev"]);
    // the safety snapshot fired before the apply
    const saveIdx = bsc.mock.calls.findIndex((c) => c[1]?.[1] === "save" && c[1]?.[2] === "Before Web App Dev");
    const applyIdx = bsc.mock.calls.findIndex((c) => c[1]?.[1] === "apply");
    expect(saveIdx).toBeGreaterThanOrEqual(0);
    expect(applyIdx).toBeGreaterThan(saveIdx);
  });

  it("cancels the apply without touching the libraries", async () => {
    await openApplyConfirm();
    fireEvent.click(screen.getByRole("button", { name: "cancel" }));
    expect(screen.queryByText('Apply "Web App Dev"?')).not.toBeInTheDocument();
    expect(bsc).not.toHaveBeenCalledWith(null, ["studio", "apply", "web"]);
    expect(hydrateComponents).not.toHaveBeenCalled();
  });
});
