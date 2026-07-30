import { describe, it, expect } from "vitest";
import { deriveChannelViews, channelKindOf } from "./channels";
import type { McpServer } from "@/features/mcp";

const mk = (over: Partial<McpServer>): McpServer => ({
  id: over.id ?? "e", name: over.name ?? "e", enabled: true, projects: [], transport: "stdio", ...over,
});

describe("channelKindOf", () => {
  it("recognizes known email/social provider names", () => {
    expect(channelKindOf("Resend")).toBe("email");
    expect(channelKindOf("Bluesky")).toBe("social");
    expect(channelKindOf("Channel (mock)")).toBe("other");
  });
});

describe("deriveChannelViews", () => {
  it("keeps only channel-shaped servers (named 'channel' or a known provider)", () => {
    const servers = [
      mk({ id: "c1", name: "Channel (mock)", enabled: false, command: "bsc-channel-mock-mcp" }),
      mk({ id: "r1", name: "Research", command: "bsc-research-mcp" }),
      mk({ id: "e1", name: "Resend", command: "resend-mcp" }),
    ];
    const views = deriveChannelViews(servers);
    expect(views.map((v) => v.id).sort()).toEqual(["c1", "e1"]);
  });

  it("marks a server installed when it has a runnable command/url", () => {
    const servers = [
      mk({ id: "c1", name: "Channel (mock)", command: "bsc-channel-mock-mcp" }),
      mk({ id: "c2", name: "Channel (broken)", command: undefined }),
      mk({ id: "c3", name: "Channel (http)", transport: "http", url: "https://x" }),
    ];
    const byId = Object.fromEntries(deriveChannelViews(servers).map((v) => [v.id, v]));
    expect(byId.c1.installed).toBe(true);
    expect(byId.c2.installed).toBe(false);
    expect(byId.c3.installed).toBe(true);
  });

  it("marks a channel assigned when its name is in the marketer stream's assignment list (case-insensitive)", () => {
    const servers = [mk({ id: "c1", name: "Channel (mock)" })];
    expect(deriveChannelViews(servers, ["channel (mock)"])[0].assigned).toBe(true);
    expect(deriveChannelViews(servers, [])[0].assigned).toBe(false);
  });
});
