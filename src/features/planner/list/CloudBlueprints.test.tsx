import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { CloudBlueprints } from "./CloudBlueprints";
import { listBlueprintGists, type BlueprintGistItem } from "@/features/planner/lib/gist/gist";

vi.mock("@/features/planner/lib/gist/gist", () => ({ listBlueprintGists: vi.fn() }));

function gist(over: Partial<BlueprintGistItem>): BlueprintGistItem {
  return { id: "g", name: "G", description: "blueprint: G", owner: "me", htmlUrl: "", updatedAt: "2026-01-01T00:00:00Z", ...over };
}
const ITEMS = [
  gist({ id: "g-a", name: "Alpha BP" }),
  gist({ id: "g-b", name: "Beta BP" }),
];

function renderColumn(props: Partial<React.ComponentProps<typeof CloudBlueprints>> = {}) {
  const onDownload = vi.fn(async () => {});
  render(
    <CloudBlueprints
      defaultSource="me" token="tok" downloadedGistIds={new Set()} onDownload={onDownload}
      {...props}
    />,
  );
  return { onDownload };
}

describe("CloudBlueprints (#3802)", () => {
  beforeEach(() => { vi.mocked(listBlueprintGists).mockReset(); });

  it("loads the source's gists and hides the already-downloaded ones (not-yet-downloaded only)", async () => {
    vi.mocked(listBlueprintGists).mockResolvedValue(ITEMS);
    renderColumn({ downloadedGistIds: new Set(["g-a"]) });
    // Beta is offered; Alpha is already in the library, so it's filtered out.
    expect(await screen.findByText("Beta BP")).toBeTruthy();
    expect(screen.queryByText("Alpha BP")).toBeNull();
    expect(vi.mocked(listBlueprintGists)).toHaveBeenCalledWith("me", "tok");
  });

  it("re-lists when the gist source is changed (the source IS the query, #3802)", async () => {
    vi.mocked(listBlueprintGists).mockImplementation(async (src: string) =>
      src === "otheruser" ? [gist({ id: "g-x", name: "Other BP" })] : ITEMS);
    renderColumn();                                   // initial source = "me"
    await screen.findByText("Alpha BP");
    expect(vi.mocked(listBlueprintGists)).toHaveBeenCalledWith("me", "tok");

    const input = screen.getByLabelText("Cloud blueprints source (GitHub account)");
    fireEvent.change(input, { target: { value: "otheruser" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(await screen.findByText("Other BP")).toBeTruthy();
    expect(vi.mocked(listBlueprintGists)).toHaveBeenCalledWith("otheruser", "tok");
    expect(screen.queryByText("Alpha BP")).toBeNull();   // the old source's gists are gone
  });

  it("calls onDownload with the gist id when Get is clicked", async () => {
    vi.mocked(listBlueprintGists).mockResolvedValue(ITEMS);
    const { onDownload } = renderColumn();
    await screen.findByText("Alpha BP");
    fireEvent.click(screen.getAllByText("Get")[0]);      // first row = g-a
    await waitFor(() => expect(onDownload).toHaveBeenCalledWith("g-a"));
  });

  it("shows the all-downloaded empty state when every gist is already in the library", async () => {
    vi.mocked(listBlueprintGists).mockResolvedValue(ITEMS);
    renderColumn({ downloadedGistIds: new Set(["g-a", "g-b"]) });
    expect(await screen.findByText(/blueprints are downloaded/i)).toBeTruthy();
  });

  it("shows the empty state when the account publishes no blueprints", async () => {
    vi.mocked(listBlueprintGists).mockResolvedValue([]);
    renderColumn();
    expect(await screen.findByText(/No blueprints published under/i)).toBeTruthy();
  });

  it("shows an error state when the gist list request fails", async () => {
    vi.mocked(listBlueprintGists).mockRejectedValue(new Error("offline"));
    renderColumn();
    expect(await screen.findByText(/Couldn't reach GitHub/i)).toBeTruthy();
  });

  it("surfaces a per-row error when a download fails (no silent swallow)", async () => {
    vi.mocked(listBlueprintGists).mockResolvedValue(ITEMS);
    const onDownload = vi.fn().mockRejectedValue(new Error("no extension.json manifest"));
    render(<CloudBlueprints defaultSource="me" token="tok" downloadedGistIds={new Set()} onDownload={onDownload} />);
    await screen.findByText("Alpha BP");
    fireEvent.click(screen.getAllByText("Get")[0]);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/Couldn't download/i);
    expect(alert).toHaveTextContent(/no extension\.json manifest/);
  });
});
