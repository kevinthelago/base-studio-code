import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { BlueprintCard } from "./BlueprintCard";
import type { BpItem } from "./blueprintLibrary.helpers";

const item = (over: Partial<BpItem> = {}): BpItem => ({
  id: "a", name: "Alpha", pitch: "", icon: "hub",
  stages: 0, sections: [], updatedLabel: "", sort: 0, ...over,
});

describe("BlueprintCard", () => {
  it("renders the blueprint name and gist label", () => {
    render(
      <BlueprintCard
        b={item({ gistLabel: "gist · abc1234" })}
        onUse={() => {}} onDelete={() => {}}
        menuOpenId={null} setMenuOpenId={() => {}}
      />,
    );
    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(screen.getByText("gist · abc1234")).toBeInTheDocument();
    // #3785: the lifecycle-category badge is gone — it was the same "greenfield" on every card.
    expect(screen.queryByText("greenfield")).toBeNull();
  });

  it("renders the blueprint's OWN glyph — two blueprints no longer share one icon (#3785)", () => {
    // Every card used to draw the same category-derived glyph, since every packaged blueprint was
    // "greenfield". `Ic` renders inline SVG paths, so compare the rendered markup.
    const glyph = (icon: string) => {
      const { container, unmount } = render(
        <BlueprintCard
          b={item({ icon })}
          onUse={() => {}} onDelete={() => {}}
          menuOpenId={null} setMenuOpenId={() => {}}
        />,
      );
      const svg = container.querySelector(".bp-rail-card-head svg")!.innerHTML;
      unmount();
      return svg;
    };
    expect(glyph("hub")).not.toEqual(glyph("checklist"));
    // An undeclared icon resolves to the generic grid, not to another blueprint's domain glyph.
    expect(glyph("category")).not.toEqual(glyph("hub"));
  });

  it("renders the blueprint DESCRIPTION, wrapped (#3840)", () => {
    const desc = "Build a CRM platform — contacts, pipeline, and service cases.";
    const { container } = render(
      <BlueprintCard
        b={item({ pitch: desc })}
        onUse={() => {}} onDelete={() => {}}
        menuOpenId={null} setMenuOpenId={() => {}}
      />,
    );
    expect(screen.getByText(desc)).toBeInTheDocument();
    // The title stays single-line + ellipsis; the description must NOT — reading it is the point.
    const el = container.querySelector(".bp-rail-card-desc") as HTMLElement;
    expect(el).toBeTruthy();
    expect(el.style.whiteSpace).toBe("normal");
  });

  it("omits the description block entirely when the blueprint has none", () => {
    const { container } = render(
      <BlueprintCard
        b={item({ pitch: "   " })}
        onUse={() => {}} onDelete={() => {}}
        menuOpenId={null} setMenuOpenId={() => {}}
      />,
    );
    expect(container.querySelector(".bp-rail-card-desc")).toBeNull();
  });

  it("selects the blueprint on a card click (onUse)", () => {
    const onUse = vi.fn();
    render(
      <BlueprintCard b={item()} onUse={onUse} onDelete={() => {}} menuOpenId={null} setMenuOpenId={() => {}} />,
    );
    fireEvent.click(screen.getByText("Alpha"));
    expect(onUse).toHaveBeenCalledWith("a");
  });

  it("shows the delete action only for non-built-in blueprints when its menu is open", () => {
    const { rerender } = render(
      <BlueprintCard b={item({ builtIn: true })} onUse={() => {}} onDelete={() => {}} menuOpenId="bp:a" setMenuOpenId={() => {}} />,
    );
    expect(screen.queryByText("delete blueprint")).not.toBeInTheDocument();

    rerender(
      <BlueprintCard b={item({ builtIn: false })} onUse={() => {}} onDelete={() => {}} menuOpenId="bp:a" setMenuOpenId={() => {}} />,
    );
    expect(screen.getByText("delete blueprint")).toBeInTheDocument();
  });
});
