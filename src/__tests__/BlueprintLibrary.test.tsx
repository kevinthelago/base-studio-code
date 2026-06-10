import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { LibraryView, gistBadge } from "../screens/projects/BlueprintLibrary";
import { makeBlueprints, type Blueprint } from "../screens/projects/blueprints";

const noop = () => {};

describe("gistBadge (#609)", () => {
  it("maps each state to a label", () => {
    expect(gistBadge({ state: "local" }).label).toMatch(/local only/);
    expect(gistBadge({ state: "dirty" }).label).toMatch(/unpublished/);
    expect(gistBadge({ state: "forked" }).label).toMatch(/forked/);
    expect(gistBadge({ state: "synced", rev: "r3" }).label).toBe("synced · r3");
  });
});

describe("LibraryView (#609 slice 4)", () => {
  const bps = (): Blueprint[] => makeBlueprints();

  it("renders a card per blueprint + the New card, with header actions", () => {
    render(<LibraryView blueprints={bps()} onOpen={noop} onMenu={noop} onNew={noop} onImport={noop} />);
    expect(screen.getByRole("heading", { name: "Blueprints", level: 1 })).toBeInTheDocument();
    for (const b of bps()) expect(screen.getByRole("heading", { name: new RegExp(b.name), level: 3 })).toBeInTheDocument();
    // both the header button and the New card match
    expect(screen.getAllByRole("button", { name: /New blueprint/i }).length).toBe(2);
    expect(screen.getByRole("button", { name: /Import from gist/i })).toBeInTheDocument();
  });

  it("selects a blueprint via Use without opening it; the active card is flagged (#658)", () => {
    const onOpen = vi.fn();
    const onUse = vi.fn();
    const list: Blueprint[] = [
      { id: "a", name: "Alpha", desc: "", sections: [] },
      { id: "b", name: "Beta", desc: "", sections: [] },
    ];
    render(<LibraryView blueprints={list} onOpen={onOpen} onUse={onUse} onMenu={noop} onNew={noop} onImport={noop} activeId="a" />);
    // the active card shows the selected badge + an "in use" button
    expect(screen.getByText("✓ selected")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "✓ in use" })).toBeInTheDocument();
    // clicking another card's "use" selects it without opening
    fireEvent.click(screen.getByRole("button", { name: "use" }));
    expect(onUse).toHaveBeenCalledWith("b");
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("opens a blueprint when its card is clicked", () => {
    const onOpen = vi.fn();
    const list = bps();
    render(<LibraryView blueprints={list} onOpen={onOpen} onMenu={noop} onNew={noop} onImport={noop} />);
    fireEvent.click(screen.getByRole("heading", { name: new RegExp(list[0].name), level: 3 }).closest(".bp-card")!);
    expect(onOpen).toHaveBeenCalledWith(list[0].id);
  });

  it("fires onMenu for the card's duplicate/more buttons", () => {
    const onMenu = vi.fn();
    const list = bps();
    render(<LibraryView blueprints={list} onOpen={noop} onMenu={onMenu} onNew={noop} onImport={noop} />);
    const card = screen.getByRole("heading", { name: new RegExp(list[0].name), level: 3 }).closest(".bp-card")!;
    fireEvent.click(within(card as HTMLElement).getByTitle("Duplicate"));
    expect(onMenu).toHaveBeenCalledWith("duplicate", expect.objectContaining({ id: list[0].id }), expect.anything());
  });

  it("New card + header New button call onNew", () => {
    const onNew = vi.fn();
    render(<LibraryView blueprints={bps()} onOpen={noop} onMenu={noop} onNew={onNew} onImport={noop} />);
    fireEvent.click(screen.getAllByRole("button", { name: /New blueprint/i })[0]); // header button
    expect(onNew).toHaveBeenCalled();
  });

  it("derives display safely for a bare blueprint (no icon/hue/gist)", () => {
    const bare: Blueprint = { id: "x", name: "zeta", desc: "d", sections: [] };
    render(<LibraryView blueprints={[bare]} onOpen={noop} onMenu={noop} onNew={noop} onImport={noop} />);
    expect(screen.getByRole("heading", { name: /zeta/, level: 3 })).toBeInTheDocument();
    // bare ⇒ local-only badge
    expect(screen.getByText(/local only/)).toBeInTheDocument();
  });
});
