// CollectionPage (#2505) — the list-shaped page composition: CardListRow items in the MasterDetail
// rail under the header bar, selection driving the item-facts detail, badges, and empty states.
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { CollectionPage, type CollectionItem } from "./CollectionPage";

const ITEMS: CollectionItem[] = [
  { id: "sr", title: "Senior Reviewer", subtitle: "Reviews diffs", badge: "planner", facts: [{ k: "model", v: "opus" }] },
  { id: "ab", title: "API Builder", badge: "worker", badgeTone: "success", meta: "14m" },
];

describe("CollectionPage — rendering", () => {
  it("renders the header bar (title · hint · count) and one CardListRow per item with badge + meta", () => {
    const { container } = render(<CollectionPage title="Personas" hint="library" items={ITEMS} />);
    expect(screen.getByText("Personas")).toBeInTheDocument();
    expect(screen.getByText("library")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument(); // the count meta
    expect(container.querySelectorAll(".card-list-row")).toHaveLength(2);
    expect(screen.getByText("planner")).toBeInTheDocument(); // badge Chip
    expect(screen.getByText("14m")).toBeInTheDocument();     // trailing meta
  });

  it("renders empty states for an empty collection and for no selection", () => {
    render(<CollectionPage title="Personas" items={[]} />);
    expect(screen.getByText("Nothing here yet")).toBeInTheDocument();
    expect(screen.getByText("No item selected")).toBeInTheDocument();
  });
});

describe("CollectionPage — selection drives the detail", () => {
  it("uncontrolled: clicking an item selects its row and renders title + subtitle + facts detail", () => {
    const onSelect = vi.fn();
    const { container } = render(<CollectionPage title="Personas" items={ITEMS} onSelect={onSelect} />);
    fireEvent.click(screen.getByText("Senior Reviewer"));
    expect(onSelect).toHaveBeenCalledWith("sr");
    expect(container.querySelectorAll(".card-list-row.selected")).toHaveLength(1);
    expect(screen.getByText("model")).toBeInTheDocument();
    expect(screen.getByText("opus")).toBeInTheDocument();
    expect(screen.getAllByText("Senior Reviewer").length).toBe(2); // row + detail heading
  });

  it("uncontrolled: defaultSelectedId seeds the initial detail", () => {
    render(<CollectionPage title="Personas" items={ITEMS} defaultSelectedId="ab" />);
    expect(screen.queryByText("No item selected")).toBeNull();
    expect(screen.getAllByText("API Builder").length).toBe(2);
  });

  it("controlled: selectedId drives the detail; a click only fires onSelect (no internal takeover)", () => {
    const onSelect = vi.fn();
    const { container } = render(
      <CollectionPage title="Personas" items={ITEMS} selectedId="sr" onSelect={onSelect} />,
    );
    fireEvent.click(screen.getByText("API Builder"));
    expect(onSelect).toHaveBeenCalledWith("ab");
    const rows = container.querySelectorAll(".card-list-row");
    expect(rows[0].className).toContain("selected");
    expect(rows[1].className).not.toContain("selected");
  });

  it("detail render-prop overrides the default", () => {
    render(<CollectionPage title="Personas" items={ITEMS} selectedId="ab"
      detail={(it) => <span>ITEM:{it.id}</span>} />);
    expect(screen.getByText("ITEM:ab")).toBeInTheDocument();
  });
});
