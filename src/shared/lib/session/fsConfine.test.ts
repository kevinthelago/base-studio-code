import { describe, it, expect } from "vitest";
import { isPathConfined, isConfigProtected } from "./fsConfine";

describe("isPathConfined", () => {
  const root = "/c/dev/repo";

  it("allows plain relative paths inside the repo", () => {
    expect(isPathConfined(root, "src/app.ts")).toBe(true);
    expect(isPathConfined(root, "a/b/c.txt")).toBe(true);
    expect(isPathConfined(root, "")).toBe(true); // not a path op
  });

  it("rejects any parent traversal", () => {
    expect(isPathConfined(root, "../other/secret")).toBe(false);
    expect(isPathConfined(root, "src/../../other")).toBe(false);
    expect(isPathConfined(root, "..")).toBe(false);
    expect(isPathConfined(root, "a/../../b")).toBe(false);
  });

  it("allows absolute paths under the repo root, rejects those outside", () => {
    expect(isPathConfined(root, "/c/dev/repo/src/app.ts")).toBe(true);
    expect(isPathConfined(root, "/c/dev/repo")).toBe(true);
    expect(isPathConfined(root, "/c/dev/other/x")).toBe(false);
    expect(isPathConfined(root, "/etc/passwd")).toBe(false);
    expect(isPathConfined(root, "~/.ssh/id_rsa")).toBe(false);
  });

  it("normalizes Windows separators and drive paths", () => {
    expect(isPathConfined("C:/dev/repo", "C:\\dev\\repo\\src\\a.ts")).toBe(true);
    expect(isPathConfined("C:/dev/repo", "C:\\dev\\other\\a.ts")).toBe(false);
  });

  it("does not treat a sibling with a shared prefix as inside (boundary)", () => {
    // /c/dev/repo2 must NOT count as under /c/dev/repo
    expect(isPathConfined(root, "/c/dev/repo2/x")).toBe(false);
  });
});

describe("isConfigProtected", () => {
  const root = "/c/dev/repo";

  it("flags the session's own .claude config (relative + absolute under root, Windows)", () => {
    expect(isConfigProtected(root, ".claude")).toBe(true);
    expect(isConfigProtected(root, ".claude/settings.json")).toBe(true);
    expect(isConfigProtected(root, "./.claude/settings.json")).toBe(true);
    expect(isConfigProtected(root, "/c/dev/repo/.claude/settings.json")).toBe(true);
    expect(isConfigProtected("C:/dev/repo", "C:\\dev\\repo\\.claude\\settings.json")).toBe(true);
  });

  it("does NOT flag ordinary files, empty paths, or a non-root .claude", () => {
    expect(isConfigProtected(root, "src/app.ts")).toBe(false);
    expect(isConfigProtected(root, "")).toBe(false);
    expect(isConfigProtected(root, "src/.claude/x")).toBe(false); // only the repo-root .claude
    expect(isConfigProtected(root, "/etc/.claude/x")).toBe(false); // outside the root (escape-checked)
    expect(isConfigProtected(root, ".claudette/x")).toBe(false); // must be the whole `.claude` segment
  });
});
