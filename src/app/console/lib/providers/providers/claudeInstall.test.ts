import { describe, it, expect } from "vitest";
import {
  CLAUDE_CLI_PKG,
  claudeFirstRunAction,
  claudeFirstRunInstall,
} from "./claudeInstall";

describe("claudeFirstRunAction (#1277)", () => {
  it("is a no-op when the CLI is already present", () => {
    expect(claudeFirstRunAction(true, true)).toEqual({ kind: "ready" });
    expect(claudeFirstRunAction(true, false)).toEqual({ kind: "ready" });
  });

  it("offers the consented npm install when the CLI is absent but npm is present", () => {
    const a = claudeFirstRunAction(false, true);
    expect(a.kind).toBe("offer-install");
    // Installs from npm — we never repackage Anthropic's proprietary bits.
    expect(a).toEqual({ kind: "offer-install", command: `npm i -g ${CLAUDE_CLI_PKG}` });
  });

  it("guides the user to docs when neither the CLI nor npm is available", () => {
    const a = claudeFirstRunAction(false, false);
    expect(a.kind).toBe("guide");
    expect(a).toEqual({ kind: "guide", docsUrl: claudeFirstRunInstall.docsUrl });
  });

  it("targets the official proprietary package", () => {
    expect(CLAUDE_CLI_PKG).toBe("@anthropic-ai/claude-code");
    expect(claudeFirstRunInstall.command).toContain("-g");
  });
});
