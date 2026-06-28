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
    const { rerender } = render(<ActivityFeed items={[]} hint="h" loading={false} tone={{}} />);
    expect(screen.getByText("No recent activity.")).toBeInTheDocument();
    rerender(<ActivityFeed items={[]} hint="h" loading={true} tone={{}} />);
    expect(screen.queryByText("No recent activity.")).not.toBeInTheDocument();
    expect(screen.getByText("Loading…")).toBeInTheDocument();
  });

  it("renders the optional right-slot control", () => {
    render(<ActivityFeed items={items} hint="h" loading={false} tone={{}} right={<button>filter</button>} />);
    expect(screen.getByRole("button", { name: "filter" })).toBeInTheDocument();
  });
});
