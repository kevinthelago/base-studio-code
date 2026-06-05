import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Tabstrip } from "../../components/chrome/Tabstrip";
import type { Tab } from "../../components/chrome/Tabstrip";

const TABS: Tab[] = [
  { name: "orchestrator", layout: "3×3", state: "run" },
  { name: "feat/tunnel",  layout: "2×2", state: "on"  },
  { name: "scratch",      layout: "1×1", state: "idle" },
];

describe("Tabstrip rendering", () => {
  it("renders all tab names", () => {
    render(<Tabstrip tabs={TABS} />);
    expect(screen.getByText("orchestrator")).toBeInTheDocument();
    expect(screen.getByText("feat/tunnel")).toBeInTheDocument();
    expect(screen.getByText("scratch")).toBeInTheDocument();
  });

  it("renders each tab's layout as a title attribute, not inline text", () => {
    const { container } = render(<Tabstrip tabs={TABS} />);
    // Layout must NOT be visible text (it would clip the tab title)
    expect(screen.queryByText("3×3")).toBeNull();
    expect(screen.queryByText("2×2")).toBeNull();
    // Layout IS accessible via the title tooltip
    const tabEls = container.querySelectorAll(".tab");
    expect(tabEls[0]).toHaveAttribute("title", "orchestrator · 3×3");
    expect(tabEls[1]).toHaveAttribute("title", "feat/tunnel · 2×2");
  });

  it("renders an add button", () => {
    render(<Tabstrip tabs={TABS} onAdd={() => {}} />);
    expect(screen.getByText("+")).toBeInTheDocument();
  });

  it("applies 'active' class to the active tab", () => {
    const { container } = render(<Tabstrip tabs={TABS} activeIdx={1} />);
    const tabEls = container.querySelectorAll(".tab");
    expect(tabEls[1]).toHaveClass("active");
    expect(tabEls[0]).not.toHaveClass("active");
  });
});

describe("Tabstrip interactions", () => {
  it("calls onSelect with the correct index when a tab is clicked", () => {
    const onSelect = vi.fn();
    render(<Tabstrip tabs={TABS} onSelect={onSelect} />);
    fireEvent.click(screen.getByText("feat/tunnel"));
    expect(onSelect).toHaveBeenCalledWith(1);
  });

  it("calls onClose when the × button is clicked", () => {
    const onClose = vi.fn();
    render(<Tabstrip tabs={TABS} onClose={onClose} />);
    const closeButtons = screen.getAllByText("×");
    fireEvent.click(closeButtons[0]);
    expect(onClose).toHaveBeenCalledWith(0);
  });

  it("does not call onSelect when the × button is clicked", () => {
    const onSelect = vi.fn();
    render(<Tabstrip tabs={TABS} onSelect={onSelect} onClose={() => {}} />);
    fireEvent.click(screen.getAllByText("×")[0]);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("calls onAdd when the + button is clicked", () => {
    const onAdd = vi.fn();
    render(<Tabstrip tabs={TABS} onAdd={onAdd} />);
    fireEvent.click(screen.getByText("+"));
    expect(onAdd).toHaveBeenCalled();
  });
});

describe("Tabstrip inline rename", () => {
  it("shows an input on double-click of the tab name", () => {
    render(<Tabstrip tabs={TABS} onRename={() => {}} />);
    fireEvent.dblClick(screen.getByText("orchestrator"));
    expect(screen.getByRole("textbox")).toBeInTheDocument();
  });

  it("pre-fills the input with the current tab name", () => {
    render(<Tabstrip tabs={TABS} onRename={() => {}} />);
    fireEvent.dblClick(screen.getByText("orchestrator"));
    const input = screen.getByRole("textbox") as HTMLInputElement;
    expect(input.value).toBe("orchestrator");
  });

  it("calls onRename with the new name when Enter is pressed", () => {
    const onRename = vi.fn();
    render(<Tabstrip tabs={TABS} onRename={onRename} />);
    fireEvent.dblClick(screen.getByText("orchestrator"));
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "new-name" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onRename).toHaveBeenCalledWith(0, "new-name");
  });

  it("cancels rename on Escape without calling onRename", () => {
    const onRename = vi.fn();
    render(<Tabstrip tabs={TABS} onRename={onRename} />);
    fireEvent.dblClick(screen.getByText("orchestrator"));
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "changed" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onRename).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("calls onRename on blur", () => {
    const onRename = vi.fn();
    render(<Tabstrip tabs={TABS} onRename={onRename} />);
    fireEvent.dblClick(screen.getByText("orchestrator"));
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "blurred-name" } });
    fireEvent.blur(input);
    expect(onRename).toHaveBeenCalledWith(0, "blurred-name");
  });

  it("does not call onRename for a blank name", () => {
    const onRename = vi.fn();
    render(<Tabstrip tabs={TABS} onRename={onRename} />);
    fireEvent.dblClick(screen.getByText("orchestrator"));
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onRename).not.toHaveBeenCalled();
  });
});

describe("Tabstrip drag-to-reorder", () => {
  // jsdom has no layout, so give each tab a deterministic 100px-wide box
  // ([0-100], [100-200], [200-300]) for the cursor→gap math.
  function layoutTabs(container: HTMLElement) {
    container.querySelectorAll<HTMLElement>(".tab").forEach((el, i) => {
      el.getBoundingClientRect = () => ({
        left: i * 100, right: i * 100 + 100, width: 100,
        top: 0, bottom: 28, height: 28, x: i * 100, y: 0, toJSON: () => ({}),
      }) as DOMRect;
    });
    const strip = container.querySelector(".tabstrip") as HTMLElement;
    // Strip box [0..300]×[0..34] so the app-wide tear-off detection has real bounds.
    strip.getBoundingClientRect = () => ({
      left: 0, right: 300, top: 0, bottom: 34, width: 300, height: 34, x: 0, y: 0, toJSON: () => ({}),
    }) as DOMRect;
    return strip;
  }

  // RTL's fireEvent.dragOver doesn't carry clientX through jsdom; dispatch a real
  // MouseEvent of type "dragover" (which does) so the gap math sees the cursor.
  function dragOverAt(strip: HTMLElement, clientX: number) {
    fireEvent(strip, new MouseEvent("dragover", { bubbles: true, cancelable: true, clientX }));
  }

  it("reorders to the gap nearest the cursor (drop zone is the whole strip)", () => {
    const onReorder = vi.fn();
    const { container } = render(<Tabstrip tabs={TABS} onReorder={onReorder} />);
    const strip = layoutTabs(container);
    fireEvent.dragStart(container.querySelectorAll(".tab")[0]);
    dragOverAt(strip, 160); // tab2's left half → gap index 2
    fireEvent.drop(strip, { clientX: 160 });
    expect(onReorder).toHaveBeenCalledWith(0, 1); // gap 2 with from=0 → final index 1
  });

  it("can drop past the last tab to move it to the end", () => {
    const onReorder = vi.fn();
    const { container } = render(<Tabstrip tabs={TABS} onReorder={onReorder} />);
    const strip = layoutTabs(container);
    fireEvent.dragStart(container.querySelectorAll(".tab")[0]);
    dragOverAt(strip, 290); // within the strip, past the last tab's midpoint → gap index 3
    fireEvent.drop(strip, { clientX: 290 });
    expect(onReorder).toHaveBeenCalledWith(0, 2);
  });

  it("does not reorder when dropped in its own slot", () => {
    const onReorder = vi.fn();
    const { container } = render(<Tabstrip tabs={TABS} onReorder={onReorder} />);
    const strip = layoutTabs(container);
    fireEvent.dragStart(container.querySelectorAll(".tab")[1]);
    dragOverAt(strip, 130); // tab1's left half → gap index 1 (own slot)
    fireEvent.drop(strip, { clientX: 130 });
    expect(onReorder).not.toHaveBeenCalled();
  });

  it("shows the tear-off preview when the tab is dragged out of the strip", () => {
    const { container } = render(<Tabstrip tabs={TABS} onReorder={vi.fn()} onTearOff={vi.fn()} />);
    layoutTabs(container);
    fireEvent.dragStart(container.querySelectorAll(".tab")[0]);
    // cursor pulled well below the strip → outside → preview appears (portaled to body)
    fireEvent(window, new MouseEvent("dragover", { bubbles: true, clientX: 150, clientY: 220 }));
    expect(document.querySelector(".tab-tearoff-preview")).toBeInTheDocument();
    // back inside the strip → preview is dismissed, reordering resumes
    fireEvent(window, new MouseEvent("dragover", { bubbles: true, clientX: 150, clientY: 12 }));
    expect(document.querySelector(".tab-tearoff-preview")).toBeNull();
  });

  it("tears off (onTearOff) when the tab is dropped outside the strip", () => {
    const onTearOff = vi.fn();
    const { container } = render(<Tabstrip tabs={TABS} onReorder={vi.fn()} onTearOff={onTearOff} />);
    layoutTabs(container);
    fireEvent.dragStart(container.querySelectorAll(".tab")[1]);
    fireEvent(window, new MouseEvent("dragover", { bubbles: true, clientX: 150, clientY: 220 }));
    fireEvent(window, new MouseEvent("drop", { bubbles: true, clientX: 150, clientY: 220 }));
    expect(onTearOff).toHaveBeenCalledWith(1);
  });

  it("does not tear off when the tab is dropped inside the strip", () => {
    const onTearOff = vi.fn();
    const { container } = render(<Tabstrip tabs={TABS} onReorder={vi.fn()} onTearOff={onTearOff} />);
    const strip = layoutTabs(container);
    fireEvent.dragStart(container.querySelectorAll(".tab")[0]);
    dragOverAt(strip, 150);
    fireEvent.drop(strip, { clientX: 150 });
    expect(onTearOff).not.toHaveBeenCalled();
  });

  it("hides tabs whose id is in hiddenIds (detached into a window)", () => {
    const T: Tab[] = [
      { id: "a", name: "Alpha", layout: "1×1" },
      { id: "b", name: "Beta", layout: "1×1" },
      { id: "c", name: "Gamma", layout: "1×1" },
    ];
    render(<Tabstrip tabs={T} hiddenIds={["b"]} />);
    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(screen.queryByText("Beta")).toBeNull();
    expect(screen.getByText("Gamma")).toBeInTheDocument();
  });

  it("highlights the strip and marks the drop gap during a drag", () => {
    const { container } = render(<Tabstrip tabs={TABS} onReorder={vi.fn()} />);
    const strip = layoutTabs(container);
    fireEvent.dragStart(container.querySelectorAll(".tab")[0]);
    dragOverAt(strip, 250); // gap at tab2 (left of it)
    expect(strip).toHaveClass("dragging");
    // the gap tab carries the insertion bar as an inline box-shadow
    const tabs = container.querySelectorAll<HTMLElement>(".tab");
    expect(tabs[2].style.boxShadow).toContain("var(--accent)");
  });
});

describe("Tabstrip context menu", () => {
  it("opens a context menu on right-click", () => {
    render(<Tabstrip tabs={TABS} />);
    fireEvent.contextMenu(screen.getByText("orchestrator"));
    expect(screen.getByText("Rename")).toBeInTheDocument();
    expect(screen.getByText("Layout")).toBeInTheDocument();
  });

  it("shows all layout options in the context menu", () => {
    render(<Tabstrip tabs={TABS} />);
    fireEvent.contextMenu(screen.getByText("orchestrator"));
    ["1×1", "2×1", "1×2", "2×2", "3×2", "3×3"].forEach((l) => {
      expect(screen.getByTitle(l)).toBeInTheDocument();
    });
  });

  it("clicking Rename in the context menu starts inline edit", () => {
    render(<Tabstrip tabs={TABS} />);
    fireEvent.contextMenu(screen.getByText("orchestrator"));
    fireEvent.click(screen.getByText("Rename"));
    expect(screen.getByRole("textbox")).toBeInTheDocument();
  });

  it("clicking a layout option calls onChangeLayout and closes the menu", () => {
    const onChangeLayout = vi.fn();
    render(<Tabstrip tabs={TABS} onChangeLayout={onChangeLayout} />);
    fireEvent.contextMenu(screen.getByText("orchestrator"));
    fireEvent.click(screen.getByTitle("2×2"));
    expect(onChangeLayout).toHaveBeenCalledWith(0, "2×2");
    expect(screen.queryByText("Layout")).toBeNull();
  });

  it("highlights the current layout in the context menu", () => {
    render(<Tabstrip tabs={TABS} />);
    fireEvent.contextMenu(screen.getByText("orchestrator")); // tab 0 has layout 3×3
    const current = screen.getByTitle("3×3");
    // The current layout button uses accent color (border is accent-dim)
    expect(current).toHaveStyle({ color: "var(--accent)" });
  });
});
