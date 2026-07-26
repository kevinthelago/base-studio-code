import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ProjectCard } from "./ProjectCard";
import type { ProjectItem } from "./projectsFilter";

const item = (over: Partial<ProjectItem> = {}): ProjectItem => ({
  id: "PVT_1", key: "PVT_1", title: "My App", description: "a cool app",
  status: "active", appType: "api", source: "board", number: 7,
  repos: ["repo-a"], itemsTotal: 3, open: 1, pct: 0.67, running: 0, paused: 0,
  updatedAt: Date.now(), ...over,
});

function card(over: Partial<ProjectItem> = {}, props: Partial<Parameters<typeof ProjectCard>[0]> = {}) {
  const it = item(over);
  return (
    <ProjectCard
      item={it}
      onOpen={() => {}} onBoard={() => {}} onDelete={() => {}}
      menuOpenId={it.id} setMenuOpenId={() => {}}
      {...props}
    />
  );
}

describe("ProjectCard", () => {
  it("renders the title, status + type chips, repos, and the open affordance", () => {
    render(card());
    expect(screen.getByText("My App")).toBeInTheDocument();
    expect(screen.getByText("active")).toBeInTheDocument();
    expect(screen.getByText("api")).toBeInTheDocument();       // type chip label
    expect(screen.getByText("repo-a")).toBeInTheDocument();
    expect(screen.getByText("open →")).toBeInTheDocument();
  });

  it("opens the project on a card click", () => {
    const onOpen = vi.fn();
    render(card({}, { onOpen }));
    fireEvent.click(screen.getByText("open →"));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("board menu reaches open-board and delete handlers", () => {
    const onBoard = vi.fn(); const onDelete = vi.fn();
    render(card({ source: "board" }, { onBoard, onDelete }));
    fireEvent.click(screen.getByText("open board on GitHub"));
    expect(onBoard).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText("delete project"));
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it("a draft card offers delete-draft (not delete-project)", () => {
    const onDelete = vi.fn();
    render(card({ id: "draft:x", source: "draft", number: undefined, repos: [] }, { menuOpenId: "draft:x", onDelete }));
    expect(screen.queryByText("delete project")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("delete draft"));
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it("a local-published card shows its key and has no ⋯ menu", () => {
    render(card({ id: "local:acme-crm", key: "acme-crm", source: "local", number: undefined, repos: [] }, { menuOpenId: "local:acme-crm" }));
    expect(screen.getByText("acme-crm")).toBeInTheDocument();
    expect(screen.queryByTitle("More options")).not.toBeInTheDocument();
  });

  it("shows the live fleet pill when agents are running", () => {
    render(card({ running: 2, paused: 1 }));
    expect(screen.getByText(/2 agents running/)).toBeInTheDocument();
  });

  it("renders the list-row variant too", () => {
    render(card({}, { variant: "row" }));
    expect(screen.getByText("My App")).toBeInTheDocument();
  });
});
