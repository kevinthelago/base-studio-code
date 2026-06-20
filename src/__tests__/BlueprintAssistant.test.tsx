import { describe, it, expect, vi } from "vitest";
import { useState } from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { BlueprintAssistant } from "../screens/planner/blueprints/BlueprintAssistant";
import { mkStageSection } from "../screens/planner/blueprints/blueprintEdit";
import type { BlueprintSection } from "../screens/planner/stages/blueprints";

function Harness({ onApplied }: { onApplied?: (s: BlueprintSection[]) => void }) {
  const [sections, setSections] = useState<BlueprintSection[]>([mkStageSection("context"), mkStageSection("stack")]);
  return <BlueprintAssistant sections={sections} name="Web app" onApply={(s) => { setSections(s); onApplied?.(s); }} onClose={() => {}} />;
}

describe("BlueprintAssistant drawer (#609 slice 6)", () => {
  it("greets and shows suggestion chips", () => {
    render(<Harness />);
    expect(screen.getByText(/reshape "Web app"/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Add a security review stage/i })).toBeInTheDocument();
  });

  it("a suggestion proposes changes, and Apply persists them", async () => {
    const onApplied = vi.fn();
    render(<Harness onApplied={onApplied} />);
    fireEvent.click(screen.getByRole("button", { name: /Make it contract-first with API gates/i }));
    // proposal appears
    await waitFor(() => expect(screen.getByText(/Proposed changes/)).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /Apply changes/i }));
    expect(onApplied).toHaveBeenCalled();
    const applied = onApplied.mock.calls[onApplied.mock.calls.length - 1][0] as BlueprintSection[];
    expect(applied.some((s) => s.key === "api")).toBe(true);
    expect(screen.getByText(/Applied to blueprint/)).toBeInTheDocument();
  });

  it("an unmappable request returns guidance, no proposal", async () => {
    render(<Harness />);
    fireEvent.change(screen.getByPlaceholderText(/Describe the change/i), { target: { value: "hello there" } });
    fireEvent.click(screen.getByRole("button", { name: "↑" }));
    await waitFor(() => expect(screen.getByText(/couldn't map that/)).toBeInTheDocument());
    expect(screen.queryByText(/Proposed changes/)).not.toBeInTheDocument();
  });
});
