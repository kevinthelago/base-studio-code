import { describe, it, expect } from "vitest";
import { avatarColor, AVATAR_PALETTE, GH_OPTION_COLORS } from "./colors";

describe("avatarColor", () => {
  it("is deterministic and always a palette member", () => {
    expect(avatarColor("octocat")).toBe(avatarColor("octocat"));
    expect(AVATAR_PALETTE).toContain(avatarColor("octocat"));
    expect(AVATAR_PALETTE).toContain(avatarColor("?"));
  });
});

describe("GH_OPTION_COLORS", () => {
  it("maps the ProjectV2 option color enum to tokens", () => {
    expect(GH_OPTION_COLORS.GREEN).toBe("var(--success)");
    expect(GH_OPTION_COLORS.RED).toBe("var(--danger)");
  });
});
