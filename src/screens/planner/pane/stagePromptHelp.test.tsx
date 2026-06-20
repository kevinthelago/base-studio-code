import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { StagePromptHelp } from "./FocusedShell";

// The per-stage "?" helper replaced the auto-injecting conductor: it lists a stage's injectable
// prompts and the USER picks one to inject into the planner chat.
describe("StagePromptHelp", () => {
  const prompts = [
    { label: "Context — overview", text: "Walk the discovery checklist one topic at a time." },
    { label: "Goal", text: "Establish the goal: the single outcome this project must achieve." },
  ];

  it("renders nothing when the stage has no prompts", () => {
    const { container } = render(<StagePromptHelp prompts={[]} onInject={() => {}} />);
    expect(container.querySelector("button")).toBeNull();
  });

  it("is closed until the ? is clicked, then lists the prompts", () => {
    render(<StagePromptHelp prompts={prompts} onInject={() => {}} />);
    expect(screen.queryByText("Goal")).toBeNull();
    fireEvent.click(screen.getByLabelText("Stage prompt helper"));
    expect(screen.getByText("Context — overview")).toBeTruthy();
    expect(screen.getByText("Goal")).toBeTruthy();
  });

  it("injects the picked prompt's full text and closes", () => {
    const onInject = vi.fn();
    render(<StagePromptHelp prompts={prompts} onInject={onInject} />);
    fireEvent.click(screen.getByLabelText("Stage prompt helper"));
    fireEvent.click(screen.getByText("Goal"));
    expect(onInject).toHaveBeenCalledWith("Establish the goal: the single outcome this project must achieve.");
    expect(screen.queryByText("Goal")).toBeNull(); // popover closed after injecting
  });
});
