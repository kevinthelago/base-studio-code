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

  it("renders each tab's layout", () => {
    render(<Tabstrip tabs={TABS} />);
    expect(screen.getAllByText("3×3")).toHaveLength(1);
    expect(screen.getAllByText("2×2")).toHaveLength(1);
  });

  it("renders an add button", () => {
    render(<Tabstrip tabs={TABS} />);
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
    render(<Tabstrip tabs={TABS} onSelect={onSelect} />);
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
    render(<Tabstrip tabs={TABS} />);
    fireEvent.dblClick(screen.getByText("orchestrator"));
    expect(screen.getByRole("textbox")).toBeInTheDocument();
  });

  it("pre-fills the input with the current tab name", () => {
    render(<Tabstrip tabs={TABS} />);
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
