import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Pane } from "./Pane";

describe("Pane (#1824)", () => {
  it("drawer mode renders header, body, and the standard remove/done footer", () => {
    const onClose = vi.fn();
    const onRemove = vi.fn();
    render(
      <Pane open header={<div className="name">My item</div>} body={<p>fields</p>} onClose={onClose} onRemove={onRemove} />,
    );
    expect(screen.getByText("My item")).toBeInTheDocument();
    expect(screen.getByText("fields")).toBeInTheDocument();
    fireEvent.click(screen.getByText("remove"));
    expect(onRemove).toHaveBeenCalled();
    fireEvent.click(screen.getByText("done"));
    expect(onClose).toHaveBeenCalled();
  });

  it("the auto-rendered close button calls onClose", () => {
    const onClose = vi.fn();
    render(<Pane open body={<p>x</p>} onClose={onClose} onRemove={vi.fn()} />);
    fireEvent.click(screen.getByLabelText("close"));
    expect(onClose).toHaveBeenCalled();
  });

  it("draft mode shows cancel/done, with done gated by commitDisabled", () => {
    const onCommit = vi.fn();
    const onClose = vi.fn();
    render(<Pane open isDraft commitDisabled body={<p>x</p>} onClose={onClose} onCommit={onCommit} onRemove={vi.fn()} />);
    expect(screen.getByText("cancel")).toBeInTheDocument();
    const done = screen.getByText("done") as HTMLButtonElement;
    expect(done.disabled).toBe(true);
    fireEvent.click(done);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("draft mode commits when enabled", () => {
    const onCommit = vi.fn();
    render(<Pane open isDraft body={<p>x</p>} onClose={vi.fn()} onCommit={onCommit} onRemove={vi.fn()} />);
    fireEvent.click(screen.getByText("done"));
    expect(onCommit).toHaveBeenCalled();
  });

  it("does not render the body while closed (drawer)", () => {
    render(<Pane open={false} body={<p>hidden</p>} onClose={vi.fn()} onRemove={vi.fn()} />);
    expect(screen.queryByText("hidden")).toBeNull();
  });

  it("inline mode renders no scrim and accepts a custom footer", () => {
    const { container } = render(
      <Pane mode="inline" header={<h2>Phase</h2>} footer={<button>advance</button>}>
        <p>phase body</p>
      </Pane>,
    );
    expect(container.querySelector(".pane-scrim")).toBeNull();
    expect(container.querySelector(".pane-inline")).not.toBeNull();
    expect(screen.getByText("Phase")).toBeInTheDocument();
    expect(screen.getByText("phase body")).toBeInTheDocument();
    expect(screen.getByText("advance")).toBeInTheDocument();
  });

  it("a supplied footer overrides the standard drawer footer", () => {
    render(<Pane open body={<p>x</p>} footer={<button>custom</button>} onClose={vi.fn()} onRemove={vi.fn()} />);
    expect(screen.getByText("custom")).toBeInTheDocument();
    expect(screen.queryByText("remove")).toBeNull();
  });
});
