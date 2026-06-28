import { describe, it, expect, vi } from "vitest";
import { useRef } from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { useClickOutside } from "./useClickOutside";

function Harness({ onClose, active, withIgnore = false }: { onClose: () => void; active: boolean; withIgnore?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const ignoreRef = useRef<HTMLButtonElement>(null);
  useClickOutside(ref, onClose, active, withIgnore ? ignoreRef : undefined);
  return (
    <div>
      <div ref={ref} data-testid="inside">menu</div>
      <button ref={ignoreRef} data-testid="toggle">toggle</button>
      <div data-testid="outside">outside</div>
    </div>
  );
}

describe("useClickOutside", () => {
  it("fires on an outside mousedown, not on an inside one", () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} active />);
    fireEvent.mouseDown(screen.getByTestId("inside"));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.mouseDown(screen.getByTestId("outside"));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("does nothing while inactive", () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} active={false} />);
    fireEvent.mouseDown(screen.getByTestId("outside"));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("ignores presses inside ignoreRef", () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} active withIgnore />);
    fireEvent.mouseDown(screen.getByTestId("toggle"));
    expect(onClose).not.toHaveBeenCalled();
  });
});
