import { describe, it, expect } from "vitest";
import { migrateLegacyExtensions } from "./migrateExtensions";

describe("migrateLegacyExtensions", () => {
  it("splits a persisted extensions list into mcpServers + hooks by kind", () => {
    const state: Record<string, unknown> = {
      extensions: [
        { id: "m1", kind: "mcp", name: "Compliance", enabled: true, projects: ["p"], transport: "stdio", command: "uv", args: "run", env: [] },
        { id: "h1", kind: "hook", name: "fmt", enabled: false, projects: [], event: "PostToolUse", matcher: "Write", hookCommand: "prettier" },
      ],
    };
    migrateLegacyExtensions(state);
    expect(state.extensions).toBeUndefined();
    expect(state.mcpServers).toEqual([
      { id: "m1", name: "Compliance", enabled: true, projects: ["p"], transport: "stdio", command: "uv", args: "run", url: undefined, env: [] },
    ]);
    // hookCommand → command on the migrated hook.
    expect(state.hooks).toEqual([
      { id: "h1", name: "fmt", enabled: false, projects: [], event: "PostToolUse", matcher: "Write", command: "prettier", env: undefined },
    ]);
  });

  it("normalizes a missing projects field to [] and a missing transport to stdio", () => {
    const state: Record<string, unknown> = {
      extensions: [{ id: "m", kind: "mcp", name: "X", enabled: true }],
    };
    migrateLegacyExtensions(state);
    expect((state.mcpServers as Array<{ projects: unknown; transport: unknown }>)[0]).toMatchObject({ projects: [], transport: "stdio" });
  });

  it("renames the persisted activeScreen route key extensions → mcp", () => {
    const state: Record<string, unknown> = { activeScreen: "extensions" };
    migrateLegacyExtensions(state);
    expect(state.activeScreen).toBe("mcp");
  });

  it("is a no-op on already-migrated or empty state", () => {
    const migrated = { mcpServers: [], hooks: [], activeScreen: "console" };
    migrateLegacyExtensions(migrated);
    expect(migrated).toEqual({ mcpServers: [], hooks: [], activeScreen: "console" });
    expect(() => migrateLegacyExtensions(undefined)).not.toThrow();
  });
});
