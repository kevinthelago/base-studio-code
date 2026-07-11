import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { StagePromptHelp } from "./FocusedShell";

// The per-stage "?" helper (#2859) presents the SINGLE most relevant prompt for the stage's CURRENT
// step (resolved upstream from substep progress) and lets the USER inject it — one at a time.
describe("StagePromptHelp (#2859)", () => {
  const prompt = { label: "Goal", text: "Establish the goal: the single outcome this project must achieve." };

  it("is closed until the ? is clicked, then shows the one current-step prompt", () => {
    render(<StagePromptHelp prompt={prompt} onInject={() => {}} />);
    expect(screen.queryByText("Goal")).toBeNull();
    fireEvent.click(screen.getByLabelText("Stage prompt helper"));
    expect(screen.getByText("Goal")).toBeTruthy();
    expect(screen.getByText(/Establish the goal/)).toBeTruthy();
  });

  it("injects the prompt's full text and closes", () => {
    const onInject = vi.fn();
    render(<StagePromptHelp prompt={prompt} onInject={onInject} />);
    fireEvent.click(screen.getByLabelText("Stage prompt helper"));
    fireEvent.click(screen.getByText("Goal"));
    expect(onInject).toHaveBeenCalledWith("Establish the goal: the single outcome this project must achieve.");
    expect(screen.queryByText("Goal")).toBeNull(); // popover closed after injecting
  });
});
