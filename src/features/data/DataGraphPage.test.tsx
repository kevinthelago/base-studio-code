// The DATA GRAPH page (the-data-graph-a-global-third-pillar).
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { DataGraphPage } from "@/features/data/DataGraphPage";

// Defaulted to a resolved promise AT DEFINITION, not just in beforeEach: the store hydrates at module
// LOAD — before any hook runs — and it calls `bscJson` too, so a bare `vi.fn()` returns undefined there
// and the `.then` on it becomes an unhandled rejection that fails the run while every test reads green.
const bscJson = vi.hoisted(() => vi.fn(async () => [] as unknown[]));
vi.mock("@/shared/lib/core/bsc", () => ({ bscJson }));

describe("DataGraphPage — the global data graph", () => {
  // Reset, then give the mock a PROMISE default. The page gained a language tab bar
  // (`define-the-axis-for-teams-data-and-sounds`), which pulls in `usePageTabs` → the store — and the
  // store's rehydrate calls `bscJson` too. A bare `mockReset()` leaves it returning `undefined`, so
  // that hydration call did `.then` on nothing and surfaced as an unhandled rejection that failed the
  // whole run while every test still reported green.
  beforeEach(() => {
    bscJson.mockReset();
    bscJson.mockResolvedValue([]);
  });

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
