import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { BlueprintUpdateModal } from "../screens/planner/blueprints/BlueprintUpdateModal";

describe("BlueprintUpdateModal (#827)", () => {
  const setup = (over: Partial<Parameters<typeof BlueprintUpdateModal>[0]> = {}) => {
    const props = {
      busy: false,
      onGoBack: vi.fn(),
      onKeep: vi.fn(),
      onRestart: vi.fn(),
      onDismiss: vi.fn(),
      ...over,
    };
    render(<BlueprintUpdateModal {...props} />);
    return props;
  };

  const btn = (name: RegExp) => screen.getByRole("button", { name });

  it("offers the three explicit choices", () => {
    setup();
    expect(btn(/go back/i)).toBeInTheDocument();
    expect(btn(/keep previous plan files/i)).toBeInTheDocument();
    expect(btn(/restart the plan/i)).toBeInTheDocument();
  });

  it("fires the matching callback for each choice", () => {
    const p = setup();
    fireEvent.click(btn(/go back/i));
    expect(p.onGoBack).toHaveBeenCalledTimes(1);
    fireEvent.click(btn(/keep previous plan files/i));
    expect(p.onKeep).toHaveBeenCalledTimes(1);
    fireEvent.click(btn(/restart the plan/i));
    expect(p.onRestart).toHaveBeenCalledTimes(1);
  });

  it("disables the mutating choices while busy, but go-back stays available", () => {
    const p = setup({ busy: true });
    fireEvent.click(btn(/keep previous plan files/i));
    fireEvent.click(btn(/restart the plan/i));
    expect(p.onKeep).not.toHaveBeenCalled();
    expect(p.onRestart).not.toHaveBeenCalled();
    fireEvent.click(btn(/go back/i));
    expect(p.onGoBack).toHaveBeenCalledTimes(1);
  });
});
