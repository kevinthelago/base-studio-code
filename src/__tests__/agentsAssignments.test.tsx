import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ProfileSelect } from "../screens/agents";
import type { AgentProfile } from "../screens/agents/agentProfiles";

const prof = (id: string, name: string, mode: AgentProfile["mode"] = "ask"): AgentProfile => ({
  id, name, color: "#888", category: "user", desc: "", mode, commands: [],
  tools: { read: "ask", grep: "ask", glob: "ask", edit: "ask", write: "ask", bash: "ask", web: "ask", task: "ask" },
  paths: { allow: [], deny: [] }, net: { allow: [] },
});

describe("Assignments ProfileSelect (#681)", () => {
  const profiles = [prof("pf_a", "Alpha"), prof("pf_b", "Bravo"), prof("pf_c", "Charlie")];

  it("opens a menu of profiles on click and picks one (not a blind cycle)", () => {
    const onPick = vi.fn();
    render(<ProfileSelect current={profiles[0]} profiles={profiles} onPick={onPick} />);
    // closed initially — options not shown
    expect(screen.queryByRole("option")).toBeNull();
    // click opens the menu with every profile as an option
    fireEvent.click(screen.getByText("Alpha"));
    expect(screen.getAllByRole("option")).toHaveLength(3);
    // picking a specific one assigns it directly
    fireEvent.click(screen.getByText("Charlie"));
    expect(onPick).toHaveBeenCalledWith("pf_c");
    // menu closes after a pick
    expect(screen.queryByRole("option")).toBeNull();
  });

  it("marks the current profile as selected in the menu", () => {
    render(<ProfileSelect current={profiles[1]} profiles={profiles} onPick={vi.fn()} />);
    fireEvent.click(screen.getAllByText("Bravo")[0]);
    const selected = screen.getAllByRole("option").filter((o) => o.getAttribute("aria-selected") === "true");
    expect(selected).toHaveLength(1);
    expect(selected[0]).toHaveTextContent("Bravo");
  });
});
