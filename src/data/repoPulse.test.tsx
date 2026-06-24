import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Pulse } from "@/features/github/Pulse";
import type { GithubRepo } from "../store";

// The Pulse screen is live-data driven (useRepoPulse → GitHub API). In tests the
// Tauri `invoke` mock resolves null, so a repo yields the loading state; no repo
// yields the empty state. The data mapping itself is covered by repoPulseLive.test.ts.

const REPO: GithubRepo = {
  id: 1, name: "base-studio-code", full_name: "kevinthelago/base-studio-code",
  private: false, description: "desktop host", language: "Rust",
  default_branch: "main", pushed_at: new Date().toISOString(),
  open_issues_count: 0, stargazers_count: 0,
} as GithubRepo;

describe("Pulse screen", () => {
  it("prompts to select a repository when none is active", () => {
    render(<Pulse repo={null} />);
    expect(screen.getByText(/select a repository/i)).toBeTruthy();
  });

  it("shows a loading state while fetching for the active repo", () => {
    render(<Pulse repo={REPO} />);
    expect(screen.getByText(/loading repo data/i)).toBeTruthy();
  });
});
