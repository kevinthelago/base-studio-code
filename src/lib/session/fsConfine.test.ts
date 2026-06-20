import { describe, it, expect } from "vitest";
import { isPathConfined } from "./fsConfine";

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
