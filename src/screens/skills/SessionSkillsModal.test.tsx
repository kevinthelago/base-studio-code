import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SessionSkillsModal } from "./SessionSkillsModal";
import { useAppStore } from "../../store";
import { blankSkill } from "../../lib/session/skills";

const SESS = "proj:checkout";

describe("SessionSkillsModal (#skills-groups, Surface B)", () => {
  beforeEach(() => {
    useAppStore.setState({
      skills: [
        { ...blankSkill(), id: "g", name: "Global skill", kind: "workflow", enabled: true, projects: [] },
        { ...blankSkill(), id: "p2", name: "Other-project skill", kind: "review", enabled: true, projects: ["other"] },
      ],
      skillGroups: [{ id: "grpA", name: "Release day", hue: "var(--accent)", skillIds: ["p2"] }],
      sessionSkillOverrides: {}, sessionSkillGroups: {},
    });
  });

  const open = () => render(<SessionSkillsModal sessionKey={SESS} projectId="proj" sessionLabel="worker · api" onClose={vi.fn()} />);

  it("shows the inherited effective state per skill", () => {
    open();
    expect(screen.getByText("on · global")).toBeTruthy();          // global skill inherited on
    // out-of-scope skill is hidden under 'Assigned' by default; switch to All to see it
    fireEvent.click(screen.getByText(/^All \(/));
    expect(screen.getByText("off · out of scope")).toBeTruthy();
  });

  it("toggling a row's switch off writes a remove override", () => {
    const { container } = open();
    const row = container.querySelector('.sess-skill-row[data-skill-id="g"]') as HTMLElement;
    fireEvent.click(row.querySelector(".sess-toggle") as HTMLElement);
    expect(useAppStore.getState().sessionSkillOverrides[SESS]).toEqual({ add: [], remove: ["g"] });
  });

  it("quick-adding a task group enables its (out-of-scope) members for the session", () => {
    open();
    fireEvent.click(screen.getByText("Release day")); // the quick-add group chip
    expect(useAppStore.getState().sessionSkillGroups[SESS]).toEqual(["grpA"]);
    // now the other-project skill reads as on · group
    expect(screen.getByText("on · group")).toBeTruthy();
  });

  it("Reset all clears overrides and group toggles for the session", () => {
    open();
    useAppStore.getState().setSessionSkill(SESS, "g", "off");
    useAppStore.getState().setSessionSkillGroup(SESS, "grpA", true);
    fireEvent.click(screen.getByText("↺ Reset all"));
    expect(useAppStore.getState().sessionSkillOverrides[SESS]).toBeUndefined();
    expect(useAppStore.getState().sessionSkillGroups[SESS]).toBeUndefined();
  });
});
