import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ProjectPane } from "./ProjectPane";
import type { Section } from "../github/ghStructure";

// ----------------------------------------------------------------
// Staged layout (#652) — activated when sections prop is provided
// ----------------------------------------------------------------

const NO_SECTIONS: Section[] = [];

const CONTEXT_SECTIONS: Section[] = [
  { k: "goal",         title: "Goal",         state: "confirmed", content: "Build a thing" },
  { k: "scope",        title: "Scope",        state: "confirmed", content: "In scope: x" },
  { k: "stack",        title: "Stack",        state: "confirmed", content: "React + TS" },
  { k: "architecture", title: "Architecture", state: "confirmed", content: "Monolith" },
];

describe("ProjectPane (v5) — staged layout", () => {
  it("renders the stepper when sections are provided", () => {
    render(<ProjectPane sections={NO_SECTIONS} linkedRepos={[]} />);
    // All 7 stage short-labels should be in the stepper
    const labels = ["Ctx", "Repos", "UI", "Str", "Perm", "Auto", "Skills"];
    for (const label of labels) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }
  });

  it("shows the active stage header (Context first)", () => {
    render(<ProjectPane sections={NO_SECTIONS} linkedRepos={[]} />);
    // "Context" appears in both the stage-header and the advance-bar; use the subtitle to
    // confirm it's the header that's showing, not just any element
    expect(screen.getByText(/Goal · scope · stack/)).toBeTruthy();
  });

  it("shows gate-met pill when all 4 context sections are confirmed", () => {
    render(<ProjectPane sections={CONTEXT_SECTIONS} linkedRepos={[]} />);
    expect(screen.getByText(/4\/4 confirmed/)).toBeTruthy();
    // Gate-met pill should have class "met"
    const pill = screen.getByText(/4\/4 confirmed/);
    expect(pill.className).toContain("met");
  });

  it("shows gate-unmet pill when context sections are incomplete", () => {
    const partial: Section[] = [
      { k: "goal", title: "Goal", state: "confirmed", content: "ok" },
    ];
    render(<ProjectPane sections={partial} linkedRepos={[]} />);
    expect(screen.getByText(/1\/4 confirmed/)).toBeTruthy();
    const pill = screen.getByText(/1\/4 confirmed/);
    expect(pill.className).toContain("unmet");
  });

  it("shows repos stage body after clicking Repos stepper node", () => {
    render(<ProjectPane sections={NO_SECTIONS} linkedRepos={["acme/payments"]} />);
    // Click the Repos stepper node (index 1) directly — stepper nodes are never disabled
    const nodes = document.querySelectorAll(".stepper-node");
    fireEvent.click(nodes[1]);
    // Repos stage body should appear
    expect(screen.getByText(/Repositories/)).toBeTruthy();
  });

  it("shows empty-state in repos body when no repos linked", () => {
    render(<ProjectPane sections={NO_SECTIONS} linkedRepos={[]} />);
    // Click the Repos stepper node directly (index 1)
    const nodes = document.querySelectorAll(".stepper-node");
    fireEvent.click(nodes[1]);
    expect(screen.getByText(/No repositories linked yet/)).toBeTruthy();
  });

  it("shows linked repo names in repos body", () => {
    render(<ProjectPane sections={CONTEXT_SECTIONS} linkedRepos={["acme/payments", "acme/web"]} />);
    // Navigate to Repos stage (Context gate is met)
    const fwdBtn = screen.getByText(/Repos →/);
    fireEvent.click(fwdBtn);
    expect(screen.getByText("payments")).toBeTruthy();
    expect(screen.getByText("web")).toBeTruthy();
  });

  it("shows done banners for completed stages above active", () => {
    render(<ProjectPane sections={CONTEXT_SECTIONS} linkedRepos={["acme/payments"]} />);
    // Move to Repos stage (Context gate met so it becomes done when we advance)
    const fwdBtn = screen.getByText(/Repos →/);
    fireEvent.click(fwdBtn);
    // Context should now show as a done banner (it's above the active stage)
    const doneBanners = document.querySelectorAll(".stage-banner.done");
    expect(doneBanners.length).toBeGreaterThan(0);
  });

  it("shows locked banners for future stages below active", () => {
    render(<ProjectPane sections={NO_SECTIONS} linkedRepos={[]} />);
    // On first stage — future stages are locked
    const lockedBanners = document.querySelectorAll(".stage-banner.locked");
    expect(lockedBanners.length).toBeGreaterThan(0);
  });

  it("back button is disabled on first stage", () => {
    render(<ProjectPane sections={NO_SECTIONS} linkedRepos={[]} />);
    // Find via the CSS class that uniquely identifies the back button
    const backBtn = document.querySelector(".advance-btn.back") as HTMLButtonElement;
    expect(backBtn).not.toBeNull();
    expect(backBtn.disabled).toBe(true);
  });

  it("advance button is disabled when gate is not met", () => {
    render(<ProjectPane sections={NO_SECTIONS} linkedRepos={[]} />);
    const fwdBtn = screen.getByText(/Repos →/);
    expect((fwdBtn as HTMLButtonElement).disabled).toBe(true);
  });

  it("advance button is enabled when gate is met", () => {
    render(<ProjectPane sections={CONTEXT_SECTIONS} linkedRepos={[]} />);
    const fwdBtn = screen.getByText(/Repos →/);
    expect((fwdBtn as HTMLButtonElement).disabled).toBe(false);
  });

  it("never renders mock/sample repos — an empty session shows real empty-states (#…)", () => {
    // No sample-data fallback remains: with no plan data, the fictional acme/payments fleet
    // must not appear in either the staged or the no-sections render.
    render(<ProjectPane sections={NO_SECTIONS} linkedRepos={[]} />);
    expect(screen.queryByText("acme/payments")).toBeNull();
    expect(screen.queryByText("Publisher MVP")).toBeNull();
  });
});

// ----------------------------------------------------------------
// Optional stage support (#676)
// ----------------------------------------------------------------
describe("ProjectPane (v5) — optional stages (#676)", () => {
  it("shows 'optional' tag in stage header when active stage is optional", () => {
    render(<ProjectPane sections={CONTEXT_SECTIONS} linkedRepos={["acme/payments"]} />);
    // Advance to UI stage (index 2) which is optional
    const fwdBtn = screen.getByText(/Repos →/);
    fireEvent.click(fwdBtn); // advance to Repos (gate met via linked repo)
    // Now advance to UI (repos gate is met because we passed a linked repo)
    // But we need gate met for repos first — skip by forcing stepper click
    const nodes = document.querySelectorAll(".stepper-node");
    fireEvent.click(nodes[2]); // UI stage (index 2)
    // "optional" tag appears in the stage header (and locked banners for future optional stages)
    expect(screen.getAllByText("optional").length).toBeGreaterThan(0);
  });

  it("advance button is enabled on an optional stage even when gate is not met", () => {
    render(<ProjectPane sections={CONTEXT_SECTIONS} linkedRepos={["acme/payments"]} />);
    // Jump directly to UI stage (optional, gate unmet unless ux section exists)
    const nodes = document.querySelectorAll(".stepper-node");
    fireEvent.click(nodes[2]); // UI stage (index 2)
    // ux section not in CONTEXT_SECTIONS → gate not met, but optional → advance should be enabled
    const fwdBtn = document.querySelector(".advance-btn.fwd") as HTMLButtonElement;
    expect(fwdBtn).not.toBeNull();
    expect(fwdBtn.disabled).toBe(false);
  });

  it("shows 'optional' tag in locked banner for future optional stages", () => {
    render(<ProjectPane sections={NO_SECTIONS} linkedRepos={[]} />);
    // UI, Automations, Skills are optional and appear as locked banners
    const optionalTags = Array.from(document.querySelectorAll(".stage-banner.locked"))
      .filter(el => el.textContent?.includes("optional"));
    expect(optionalTags.length).toBeGreaterThan(0);
  });

  it("forward navigation skips empty optional stages", () => {
    // Start at repos stage (index 1) and advance — UI (optional, no ux section) should be skipped
    render(<ProjectPane sections={CONTEXT_SECTIONS} linkedRepos={["acme/payments"]} />);
    // Move from Context to Repos
    const fwdBtn1 = screen.getByText(/Repos →/);
    fireEvent.click(fwdBtn1);
    // Now at Repos stage. Advancing should skip UI (optional, no ux) to Structure
    // The fwd button label reflects the skip target
    const fwdBtn2 = screen.getByText(/Str →|Structure →/);
    expect(fwdBtn2).toBeTruthy();
  });
});
