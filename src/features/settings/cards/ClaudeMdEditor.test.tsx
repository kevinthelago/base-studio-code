import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ClaudeMdEditor } from "./ClaudeMdEditor";

describe("ClaudeMdEditor", () => {
  it("renders the header, target label, and the instructions value", () => {
    render(
      <ClaudeMdEditor
        instructions="hello world"
        setInstructions={() => {}}
        setActiveProfileId={() => {}}
        reading={false}
        targetLabel="octo/repo"
      />,
    );
    expect(screen.getByText("CLAUDE.md")).toBeInTheDocument();
    expect(screen.getByText("octo/repo")).toBeInTheDocument();
    expect(screen.getByDisplayValue("hello world")).toBeInTheDocument();
  });

  it("shows the loading indicator while reading", () => {
    render(
      <ClaudeMdEditor
        instructions=""
        setInstructions={() => {}}
        setActiveProfileId={() => {}}
        reading={true}
        targetLabel="global"
      />,
    );
    expect(screen.getByText("loading…")).toBeInTheDocument();
  });

  it("propagates edits and clears the active profile", () => {
    const setInstructions = vi.fn();
    const setActiveProfileId = vi.fn();
    render(
      <ClaudeMdEditor
        instructions=""
        setInstructions={setInstructions}
        setActiveProfileId={setActiveProfileId}
        reading={false}
        targetLabel="global"
      />,
    );
    fireEvent.change(screen.getByDisplayValue(""), { target: { value: "x" } });
    expect(setInstructions).toHaveBeenCalledWith("x");
    expect(setActiveProfileId).toHaveBeenCalledWith(null);
  });
});
