// The DATA GRAPH page (the-data-graph-a-global-third-pillar).
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { DataGraphPage } from "@/features/data/DataGraphPage";

const bscJson = vi.hoisted(() => vi.fn());
vi.mock("@/shared/lib/core/bsc", () => ({ bscJson }));

describe("DataGraphPage — the global data graph", () => {
  beforeEach(() => bscJson.mockReset());

  it("reads the GLOBAL entity store, with no project key", async () => {
    // The whole point of the pillar: this is OUR data model, not a project's, so it must not be
    // scoped by a project key the way the per-project Data Model is.
    bscJson.mockResolvedValue([]);
    render(<DataGraphPage />);
    await screen.findByText(/No entities yet/i);
    expect(bscJson).toHaveBeenCalledWith(null, ["data", "entity", "list"], []);
  });

  it("marks a SINGLE-instance entity, which is the fact no other pillar could state", async () => {
    // `instances: single` is why the app store can live in a graph at all — it says a live thing
    // exists exactly once, so nothing may vendor a second copy of it.
    bscJson.mockResolvedValue([
      { id: "app-store", name: "AppStore", instances: "single", provides: "@/store" },
      { id: "store-console", name: "Console", fields: ["a", "b"] },
    ]);
    render(<DataGraphPage />);
    expect(await screen.findByText("AppStore")).toBeInTheDocument();
    expect(screen.getByText(/single instance/i)).toBeInTheDocument();

    // …and an ordinary entity is NOT marked, or the badge would mean nothing.
    const many = screen.getByText("Console").closest("div");
    expect(many?.textContent).not.toMatch(/single instance/i);
  });

  it("shows an entity's fields and caps the list rather than rendering an unbounded row", async () => {
    bscJson.mockResolvedValue([
      { id: "big", name: "Big", fields: Array.from({ length: 20 }, (_, i) => `f${i}`) },
    ]);
    render(<DataGraphPage />);
    expect(await screen.findByText("f0")).toBeInTheDocument();
    expect(screen.getByText("+8 more")).toBeInTheDocument();
    expect(screen.queryByText("f19")).not.toBeInTheDocument();
  });
});
