import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Modal } from "./WorkerDetailModal";

describe("WorkerDetail Modal shell (#499)", () => {
  it("renders its title, children, and footer", () => {
    render(
      <Modal title="Change profile" onClose={() => {}} footer={<span>footer-action</span>}>
        <span>body-content</span>
      </Modal>,
    );
    expect(screen.getByText("Change profile")).toBeInTheDocument();
    expect(screen.getByText("body-content")).toBeInTheDocument();
    expect(screen.getByText("footer-action")).toBeInTheDocument();
  });

  it("fires onClose when the close button is clicked", () => {
    const onClose = vi.fn();
    render(<Modal title="Stop" onClose={onClose}>x</Modal>);
    fireEvent.click(screen.getByRole("button", { name: "close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
