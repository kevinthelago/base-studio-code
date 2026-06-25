// #1362 — the Pending-lessons review queue: renders candidates and confirms one into a project skill.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { LessonsTab } from "./LessonsTab";
import { useAppStore } from "@/store";
import type { Lesson } from "./lib/lessons";

const LESSON: Lesson = {
  id: "L1", mistake: "Blind-deleted conflict markers", cause: "", rule: "Verify the build after resolving",
  provenance: "pane t0p2", status: "pending", seen: 2, createdAt: 0, updatedAt: 0,
};

describe("LessonsTab (#1362)", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockResolvedValue(undefined);
    useAppStore.setState({ skills: [], skillGroups: [] });
  });

  it("shows the no-project empty state when there's no active project", () => {
    render(<LessonsTab projectKey="" />);
    expect(screen.getByText("No active project")).toBeTruthy();
  });

  it("renders the pending queue and confirms a lesson into a project-scoped skill", async () => {
    const calls: string[] = [];
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      calls.push(cmd);
      return cmd === "plan_lesson_list" ? [LESSON] : undefined;
    });

    render(<LessonsTab projectKey="proj-key" projectName="Proj" />);

    // The candidate renders (mistake → rule + seen badge).
    await waitFor(() => expect(screen.getByText("Blind-deleted conflict markers")).toBeTruthy());
    expect(screen.getByText("seen ×2")).toBeTruthy();

    fireEvent.click(screen.getByText("confirm"));

    // The verdict is recorded AND a project-scoped skill is created in the store.
    await waitFor(() => expect(calls).toContain("plan_lesson_confirm"));
    const skills = useAppStore.getState().skills;
    const made = skills.find((s) => s.id === "lesson-skill-L1");
    expect(made).toBeTruthy();
    expect(made!.kind).toBe("review");
    expect(made!.projects).toEqual(["proj-key"]);
  });
});
