import { describe, it, expect } from "vitest";
import { resolveIssueAssignee } from "./fleetAssignee";
import type { AgentStream } from "../stages/planSections";

const stream = (over: Partial<AgentStream>): AgentStream => ({
  id: "auth-ui", name: "Auth UI", repo: "own/web", owns: [], issues: [], dependsOn: [], ...over,
});

describe("resolveIssueAssignee (#847)", () => {
  const streams = [
    stream({ id: "auth-ui", assignee: "alice" }),
    stream({ id: "api", assignee: "  bob  " }),
    stream({ id: "infra" }), // no assignee
  ];

  it("uses the owning stream's configured login", () => {
    expect(resolveIssueAssignee("auth-ui", streams, "owner")).toBe("alice");
  });

  it("trims the stream login", () => {
    expect(resolveIssueAssignee("api", streams, "owner")).toBe("bob");
  });

  it("falls back to the viewer when the stream has no assignee", () => {
    expect(resolveIssueAssignee("infra", streams, "owner")).toBe("owner");
  });

  it("falls back to the viewer when the issue has no owning stream", () => {
    expect(resolveIssueAssignee(undefined, streams, "owner")).toBe("owner");
    expect(resolveIssueAssignee("nonexistent", streams, "owner")).toBe("owner");
  });

  it("returns null only when there is neither a stream login nor a viewer", () => {
    expect(resolveIssueAssignee("infra", streams, "")).toBeNull();
    expect(resolveIssueAssignee("infra", streams, "   ")).toBeNull();
  });

  it("prefers the stream login even when a viewer exists", () => {
    expect(resolveIssueAssignee("auth-ui", streams, "owner")).not.toBe("owner");
  });
});
