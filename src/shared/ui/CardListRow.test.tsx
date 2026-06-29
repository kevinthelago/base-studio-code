import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { CardListRow } from "./CardListRow";

describe("CardListRow", () => {
  it("renders lead/title/badge/subtitle/trailing and fires onClick", () => {
    const onClick = vi.fn();
    render(
      <CardListRow
        lead={<span data-testid="dot" />}
        title="my-server"
        badge={<span>http</span>}
        subtitle="node server.js"
        trailing={<button>toggle</button>}
        onClick={onClick}
      />,
    );
    expect(screen.getByText("my-server")).toBeInTheDocument();
    expect(screen.getByText("http")).toBeInTheDocument();
    expect(screen.getByText("node server.js")).toBeInTheDocument();
    expect(screen.getByTestId("dot")).toBeInTheDocument();
    fireEvent.click(screen.getByText("my-server"));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("applies selected + off state classes and omits the subtitle when absent", () => {
    const { container, rerender } = render(<CardListRow title="a" selected />);
    expect((container.firstChild as HTMLElement).className).toContain("selected");
    expect(container.querySelector(".clr-desc")).toBeNull();
    rerender(<CardListRow title="a" off />);
    expect((container.firstChild as HTMLElement).className).toContain("off");
  });
});
