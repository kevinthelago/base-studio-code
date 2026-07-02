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
    // Lessons now flow through the generic `bsc` bridge (#2114): `bsc plan lesson list` returns the
    // JSON array as stdout; other verbs (confirm) return empty stdout.
    const calls: Array<{ cmd: string; args: unknown }> = [];
    vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
      calls.push({ cmd, args });
      if (cmd === "bsc") {
        const a = (args as { args?: string[] }).args ?? [];
        return a.includes("list") ? JSON.stringify([LESSON]) : "";
      }
      return undefined;
    });

    render(<LessonsTab projectKey="proj-key" projectName="Proj" />);

    // The candidate renders (mistake → rule + seen badge).
    await waitFor(() => expect(screen.getByText("Blind-deleted conflict markers")).toBeTruthy());
    expect(screen.getByText("seen ×2")).toBeTruthy();

    fireEvent.click(screen.getByText("confirm"));

    // The verdict is recorded (`bsc plan lesson confirm L1`) AND a project-scoped skill is created.
    await waitFor(() =>
      expect(
        calls.some(
          (c) => c.cmd === "bsc" && ((c.args as { args?: string[] }).args ?? []).join(" ") === "plan lesson confirm L1",
        ),
      ).toBe(true),
    );
    const skills = useAppStore.getState().skills;
    const made = skills.find((s) => s.id === "lesson-skill-L1");
    expect(made).toBeTruthy();
    expect(made!.kind).toBe("review");
    expect(made!.projects).toEqual(["proj-key"]);
  });
});
