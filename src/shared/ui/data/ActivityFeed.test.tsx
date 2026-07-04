import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ActivityFeed, type ActivityItem } from "./ActivityFeed";

const items: ActivityItem[] = [
  { login: "alice", action: "merged", target: "#12 fix bug", repo: "org/web", createdAt: new Date().toISOString() },
  { login: "bob", action: "pushed", target: "abc123 wip", repo: "org/api", createdAt: new Date().toISOString() },
];

describe("ActivityFeed", () => {
  it("renders the hint and a row per item with action/target/repo", () => {
    render(<ActivityFeed items={items} hint="across all repos" loading={false} tone={{ merged: "var(--success)" }} />);
    expect(screen.getByText("across all repos")).toBeInTheDocument();
    expect(screen.getByText("merged")).toBeInTheDocument();
    expect(screen.getByText("#12 fix bug")).toBeInTheDocument();
    expect(screen.getByText("org/api")).toBeInTheDocument();
  });

  it("shows the empty state only when not loading and there are no items", () => {
    const { container, rerender } = render(<ActivityFeed items={[]} hint="h" loading={false} tone={{}} />);
    // The empty state now renders via <EmptyState> (title has no trailing period).
    expect(screen.getByText("No recent activity")).toBeInTheDocument();
    rerender(<ActivityFeed items={[]} hint="h" loading={true} tone={{}} />);
    expect(screen.queryByText("No recent activity")).not.toBeInTheDocument();
    // Loading now renders shimmer skeleton rows (#2234) rather than a "Loading…" label.
    const shimmers = Array.from(container.querySelectorAll<HTMLElement>('[aria-hidden="true"]'))
      .filter(el => (el.getAttribute("style") ?? "").includes("skeleton-shimmer"));
    expect(shimmers.length).toBeGreaterThan(0);
  });

  it("renders the optional right-slot control", () => {
    render(<ActivityFeed items={items} hint="h" loading={false} tone={{}} right={<button>filter</button>} />);
    expect(screen.getByRole("button", { name: "filter" })).toBeInTheDocument();
  });
});
