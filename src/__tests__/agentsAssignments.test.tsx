import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ProfileSelect, appSessionTag, appSessionOpenLabel, appReachNote } from "../screens/agents";
import { APP_ROLES, findProfile, type AgentProfile } from "../screens/agents/agentProfiles";

describe("app-session role labels (#740)", () => {
  it("each app role gets a distinct type chip — no non-librarian collapses to 'librarian'", () => {
    const tags = APP_ROLES.map((r) => appSessionTag(r));
    expect(new Set(tags).size).toBe(APP_ROLES.length); // all distinct
    expect(appSessionTag(findProfile("sys_planner")!)).toMatch(/planner/i);
    expect(appSessionTag(findProfile("sys_librarian")!)).toMatch(/librarian/i);
    expect(appSessionTag(findProfile("sys_blueprint_assistant")!)).toMatch(/blueprint/i);
    expect(appSessionTag(findProfile("sys_planning_autopilot")!)).toMatch(/autopilot/i);
  });

  it("the 'open …' button + reach note are role-correct, not planner/librarian binaries", () => {
    expect(appSessionOpenLabel(findProfile("sys_blueprint_assistant")!)).toBe("blueprints");
    expect(appSessionOpenLabel(findProfile("sys_planning_autopilot")!)).toBe("settings");
    // one-shot helpers aren't described as reached through Knowledge blocks
    expect(appReachNote(findProfile("sys_blueprint_assistant")!)).not.toMatch(/Knowledge blocks/);
    expect(appReachNote(findProfile("sys_planning_autopilot")!)).toMatch(/one-shot helper/);
    expect(appReachNote(findProfile("sys_librarian")!)).toMatch(/Knowledge blocks/);
  });
});

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
