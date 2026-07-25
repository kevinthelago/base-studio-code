import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { BlueprintCard } from "./BlueprintCard";
import type { BpItem } from "./blueprintLibrary.helpers";

const item = (over: Partial<BpItem> = {}): BpItem => ({
  id: "a", name: "Alpha", pitch: "", category: "greenfield",
  stages: 0, sections: [], updatedLabel: "", sort: 0, ...over,
});

describe("BlueprintCard", () => {
  it("renders the blueprint name, category and gist label", () => {
    render(
      <BlueprintCard
        b={item({ gistLabel: "gist · abc1234" })}
        onUse={() => {}} onDelete={() => {}}
        menuOpenId={null} setMenuOpenId={() => {}}
      />,
    );
    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(screen.getByText("greenfield")).toBeInTheDocument();
    expect(screen.getByText("gist · abc1234")).toBeInTheDocument();
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
