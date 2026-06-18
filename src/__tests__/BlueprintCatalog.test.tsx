import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { CatalogView } from "../screens/projects/BlueprintCatalogView";
import { NewBlueprintModal, PublishModal, ImportModal, type PreviewBlueprint } from "../screens/projects/BlueprintModals";
import { mkStageSection } from "../screens/projects/blueprintEdit";
import { gistUpdateAvailable } from "../screens/projects/blueprintCatalog";
import type { Blueprint } from "../screens/projects/blueprints";

vi.mock("../lib/extensions/gist", () => ({ listBlueprintGists: vi.fn() }));
import { listBlueprintGists } from "../lib/extensions/gist";
const mockList = vi.mocked(listBlueprintGists);

const noop = () => {};

describe("CatalogView (#923 — gist source)", () => {
  const gists = [
    { id: "abc1234567", name: "Realtime API", description: "blueprint: Realtime API", owner: "kevinthelago", htmlUrl: "https://gist.github.com/kevinthelago/abc1234567", updatedAt: new Date().toISOString() },
    { id: "def7654321", name: "Data Pipeline", description: "blueprint: Data Pipeline", owner: "kevinthelago", htmlUrl: "https://gist.github.com/kevinthelago/def7654321", updatedAt: new Date().toISOString() },
  ];
  beforeEach(() => mockList.mockReset());

  it("lists the source's blueprint gists and filters by search", async () => {
    mockList.mockResolvedValue(gists);
    render(<CatalogView source="kevinthelago" onImport={noop} onBack={noop} onManualImport={noop} />);
    expect(await screen.findByText("Realtime API")).toBeInTheDocument();
    expect(screen.getByText("Data Pipeline")).toBeInTheDocument();
    expect(mockList).toHaveBeenCalledWith("kevinthelago", "");
    fireEvent.change(screen.getByPlaceholderText(/search blueprints/i), { target: { value: "realtime" } });
    expect(screen.getByText("Realtime API")).toBeInTheDocument();
    expect(screen.queryByText("Data Pipeline")).not.toBeInTheDocument();
  });

  it("imports a gist by id (passing its updatedAt) and disables an up-to-date already-imported one", async () => {
    mockList.mockResolvedValue(gists);
    const onImport = vi.fn();
    // abc imported and CURRENT (recorded updatedAt === the gist's) → disabled "✓ Imported".
    render(<CatalogView source="kevinthelago" importedById={{ abc1234567: { updatedAt: gists[0].updatedAt } }} onImport={onImport} onBack={noop} onManualImport={noop} />);
    await screen.findByText("Realtime API");
    const realtimeRow = screen.getByText("Realtime API").closest(".cat-row") as HTMLElement;
    expect(within(realtimeRow).getByRole("button", { name: /Imported/i })).toBeDisabled();
    const dataRow = screen.getByText("Data Pipeline").closest(".cat-row") as HTMLElement;
    fireEvent.click(within(dataRow).getByRole("button", { name: /^Import$/i }));
    expect(onImport).toHaveBeenCalledWith("def7654321", gists[1].updatedAt);
  });

  it("renders an Update button (not Import) when the imported copy is out of date (#955)", async () => {
    mockList.mockResolvedValue(gists);
    const onImport = vi.fn();
    // abc imported with an OLDER updatedAt than the gist now has → out of date → "Update".
    render(<CatalogView source="kevinthelago" importedById={{ abc1234567: { updatedAt: "2000-01-01T00:00:00Z" } }} onImport={onImport} onBack={noop} onManualImport={noop} />);
    await screen.findByText("Realtime API");
    const realtimeRow = screen.getByText("Realtime API").closest(".cat-row") as HTMLElement;
    expect(within(realtimeRow).queryByRole("button", { name: /^Import$/i })).toBeNull();
    fireEvent.click(within(realtimeRow).getByRole("button", { name: /Update/i }));
    expect(onImport).toHaveBeenCalledWith("abc1234567", gists[0].updatedAt);
  });

  it("shows an empty state when the source has no blueprint gists", async () => {
    mockList.mockResolvedValue([]);
    render(<CatalogView source="kevinthelago" onImport={noop} onBack={noop} onManualImport={noop} />);
    expect(await screen.findByText(/No blueprint gists found/i)).toBeInTheDocument();
  });
});

describe("gistUpdateAvailable (#955)", () => {
  it("is true only when the gist's current updatedAt is strictly newer than the imported one", () => {
    expect(gistUpdateAvailable("2026-06-18T12:00:00Z", "2026-06-01T00:00:00Z")).toBe(true);
    expect(gistUpdateAvailable("2026-06-01T00:00:00Z", "2026-06-18T12:00:00Z")).toBe(false); // older upstream
    expect(gistUpdateAvailable("2026-06-01T00:00:00Z", "2026-06-01T00:00:00Z")).toBe(false); // same ⇒ current
  });
  it("can't tell (⇒ not stale) when either timestamp is missing or unparseable", () => {
    expect(gistUpdateAvailable(undefined, "2026-06-01T00:00:00Z")).toBe(false);
    expect(gistUpdateAvailable("2026-06-18T12:00:00Z", undefined)).toBe(false);
    expect(gistUpdateAvailable("not-a-date", "2026-06-01T00:00:00Z")).toBe(false);
  });
});

describe("NewBlueprintModal (#923)", () => {
  it("collects just a name and creates (→ opens the planner to author it)", () => {
    const onCreate = vi.fn();
    render(<NewBlueprintModal onClose={noop} onCreate={onCreate} />);
    fireEvent.change(screen.getByPlaceholderText(/Internal tool/i), { target: { value: "My BP" } });
    fireEvent.click(screen.getByRole("button", { name: /Create & open planner/i }));
    expect(onCreate).toHaveBeenCalledWith("My BP");
  });

  it("has no 'Design with Claude' option (#923 removed it)", () => {
    render(<NewBlueprintModal onClose={noop} onCreate={vi.fn()} />);
    expect(screen.queryByText("Design with Claude")).toBeNull();
  });
});

describe("PublishModal (#609)", () => {
  const bp: Blueprint = { id: "b", name: "Web", desc: "d", icon: "W", h: 230, sections: [mkStageSection("context")] };
  it("runs the async publish then surfaces the link", async () => {
    const onPublish = vi.fn(async () => ({ url: "gist.github.com/you/abc", id: "abc", rev: "r1" }));
    const onPublished = vi.fn();
    render(<PublishModal bp={bp} onClose={noop} onPublish={onPublish} onPublished={onPublished} />);
    fireEvent.click(screen.getByRole("button", { name: /Publish gist/i }));
    await waitFor(() => expect(screen.getByText("gist.github.com/you/abc")).toBeInTheDocument());
    expect(onPublish).toHaveBeenCalledWith(true); // default public
    fireEvent.click(screen.getByRole("button", { name: /Done/i }));
    expect(onPublished).toHaveBeenCalledWith(expect.objectContaining({ id: "abc", public: true }));
  });
});

describe("ImportModal (#609)", () => {
  it("resolves a gist ref to a preview then imports", async () => {
    const preview: PreviewBlueprint = { name: "Imported", icon: "I", h: 70, author: "x", rev: "r2", sections: [mkStageSection("context"), mkStageSection("stack")] };
    const onResolve = vi.fn(async () => preview);
    const onImport = vi.fn();
    render(<ImportModal onClose={noop} onResolve={onResolve} onImport={onImport} />);
    fireEvent.change(screen.getByPlaceholderText(/gist.github.com/i), { target: { value: "abc123" } });
    fireEvent.click(screen.getByRole("button", { name: /Resolve gist/i }));
    await waitFor(() => expect(screen.getByText("Imported")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /Import to library/i }));
    expect(onImport).toHaveBeenCalledWith(preview);
  });
});

