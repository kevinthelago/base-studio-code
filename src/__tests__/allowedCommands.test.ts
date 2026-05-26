import { describe, it, expect } from "vitest";
import { resolveAllowedCommands, normalizeCommand, parseCommandsFile } from "../lib/allowedCommands";

describe("normalizeCommand", () => {
  it("trims and lowercases", () => {
    expect(normalizeCommand("  GH  ")).toBe("gh");
  });
});

describe("resolveAllowedCommands", () => {
  it("unions the three scopes in global→project→repo order, deduped", () => {
    expect(resolveAllowedCommands(["gh"], ["npm"], ["cargo"])).toEqual(["gh", "npm", "cargo"]);
  });

  it("dedupes across scopes (case-insensitively)", () => {
    expect(resolveAllowedCommands(["npm"], ["NPM"], ["npm "])).toEqual(["npm"]);
  });

  it("drops blank entries", () => {
    expect(resolveAllowedCommands(["", "  "], ["cargo"], [])).toEqual(["cargo"]);
  });

  it("returns [] when every scope is empty or omitted", () => {
    expect(resolveAllowedCommands()).toEqual([]);
    expect(resolveAllowedCommands([], [], [])).toEqual([]);
  });

  it("keeps a repo-only command when global and project are empty", () => {
    expect(resolveAllowedCommands([], [], ["pytest"])).toEqual(["pytest"]);
  });
});

describe("parseCommandsFile", () => {
  it("parses project and per-repo command lists", () => {
    const json = '{"project":["cargo"],"repos":{"owner/web":["npm","pnpm"],"owner/api":["pytest"]}}';
    expect(parseCommandsFile(json)).toEqual({
      project: ["cargo"],
      repos: { "owner/web": ["npm", "pnpm"], "owner/api": ["pytest"] },
    });
  });

  it("normalizes, dedupes, and drops non-strings", () => {
    const json = '{"project":["Cargo","cargo",2,""],"repos":{"o/r":["NPM"]}}';
    expect(parseCommandsFile(json)).toEqual({ project: ["cargo"], repos: { "o/r": ["npm"] } });
  });

  it("omits repos with no valid commands", () => {
    expect(parseCommandsFile('{"repos":{"o/r":[]}}')).toEqual({ project: [], repos: {} });
  });

  it("returns empty on bad JSON, empty, or non-object input", () => {
    expect(parseCommandsFile("not json")).toEqual({ project: [], repos: {} });
    expect(parseCommandsFile("")).toEqual({ project: [], repos: {} });
    expect(parseCommandsFile("[1,2]")).toEqual({ project: [], repos: {} });
  });
});
