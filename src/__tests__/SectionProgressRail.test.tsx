import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { SectionProgressRail } from "../screens/projects/SectionProgressRail";
import type { Section } from "../screens/projects/ghStructure";

const mkSection = (k: string, state: Section["state"], content = ""): Section => ({
  k, title: k, state, content,
});

const EMPTY_MAP = new Map<string, Section>();

function mkMap(sections: Section[]): Map<string, Section> {
  return new Map(sections.map(s => [s.k, s]));
}

describe("SectionProgressRail", () => {
  it("renders nothing when there are no sections", () => {
    const { container } = render(
      <SectionProgressRail projectKeys={[]} repoGroups={[]} sectionByKey={EMPTY_MAP} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders one node per section key", () => {
    const sections = [
      mkSection("goal", "confirmed"),
      mkSection("scope", "drafted"),
      mkSection("stack", "pending"),
    ];
    const { container } = render(
      <SectionProgressRail
        projectKeys={["goal", "scope", "stack"]}
        repoGroups={[]}
        sectionByKey={mkMap(sections)}
      />,
    );
    const nodes = container.querySelectorAll(".rail-node");
    expect(nodes.length).toBe(3);
  });

  it("marks the confirmed count in the summary pill", () => {
    const sections = [
      mkSection("goal", "confirmed"),
      mkSection("scope", "confirmed"),
      mkSection("stack", "pending"),
    ];
    const { getByText } = render(
      <SectionProgressRail
        projectKeys={["goal", "scope", "stack"]}
        repoGroups={[]}
        sectionByKey={mkMap(sections)}
      />,
    );
    expect(getByText(/2✓/)).toBeTruthy();
  });

  it("shows 'banked' pill when a drafted section follows a pending one", () => {
    const sections = [
      mkSection("goal", "confirmed"),
      mkSection("scope", "pending"),
      mkSection("stack", "drafted", "some content"),
    ];
    const { getByText } = render(
      <SectionProgressRail
        projectKeys={["goal", "scope", "stack"]}
        repoGroups={[]}
        sectionByKey={mkMap(sections)}
      />,
    );
    expect(getByText(/1 banked/)).toBeTruthy();
  });

  it("does not show 'banked' pill when no sections are banked", () => {
    const sections = [
      mkSection("goal", "confirmed"),
      mkSection("scope", "drafted"),
    ];
    const { queryByText } = render(
      <SectionProgressRail
        projectKeys={["goal", "scope"]}
        repoGroups={[]}
        sectionByKey={mkMap(sections)}
      />,
    );
    expect(queryByText(/banked/)).toBeNull();
  });

  it("adds the rail-node-now class on an active (now) section node", () => {
    const sections = [
      mkSection("goal", "confirmed"),
      mkSection("scope", "drafted"),
      mkSection("stack", "pending"),
    ];
    const { container } = render(
      <SectionProgressRail
        projectKeys={["goal", "scope", "stack"]}
        repoGroups={[]}
        sectionByKey={mkMap(sections)}
      />,
    );
    const nowNodes = container.querySelectorAll(".rail-node-now");
    // "scope" is drafted with no pending before it → now
    expect(nowNodes.length).toBe(1);
  });

  it("shows 'active N' when there are now-state sections", () => {
    const sections = [
      mkSection("goal", "confirmed"),
      mkSection("scope", "drafted"),
    ];
    const { getByText } = render(
      <SectionProgressRail
        projectKeys={["goal", "scope"]}
        repoGroups={[]}
        sectionByKey={mkMap(sections)}
      />,
    );
    expect(getByText(/active/)).toBeTruthy();
  });

  it("renders a divider between project and repo groups", () => {
    const sections = [
      mkSection("goal", "confirmed"),
      mkSection("repo__web__api", "pending"),
    ];
    const { container } = render(
      <SectionProgressRail
        projectKeys={["goal"]}
        repoGroups={[{ repo: "web", keys: ["repo__web__api"] }]}
        sectionByKey={mkMap(sections)}
      />,
    );
    // Group dividers are <span> elements with specific inline width style
    const dividers = Array.from(container.querySelectorAll("span")).filter(
      el => (el as HTMLElement).style.width === "1px",
    );
    expect(dividers.length).toBeGreaterThanOrEqual(1);
  });

  it("handles missing sections gracefully (treats as pending)", () => {
    // sectionByKey doesn't contain the key — should fall back to pending
    const { container } = render(
      <SectionProgressRail
        projectKeys={["goal", "missing_key"]}
        repoGroups={[]}
        sectionByKey={mkMap([mkSection("goal", "confirmed")])}
      />,
    );
    const nodes = container.querySelectorAll(".rail-node");
    expect(nodes.length).toBe(2);
  });
});
