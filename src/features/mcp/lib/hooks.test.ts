import { describe, it, expect } from "vitest";
import { resolveHooks, toHookPayload, hookFromCatalog, blankHook, SYSTEM_HOOKS, type Hook } from "./hooks";

const mk = (over: Partial<Hook>): Hook => ({
  id: "h", name: over.id ?? "h", enabled: true, projects: [], event: "PostToolUse", command: "fmt", ...over,
});

describe("resolveHooks", () => {
  it("includes enabled globals + this-project matches; drops disabled and other projects", () => {
    const all = [
      mk({ id: "g", projects: [] }),
      mk({ id: "p", projects: ["P1"] }),
      mk({ id: "off", projects: [], enabled: false }),
    ];
    expect(resolveHooks(all, "P1").map(e => e.id)).toEqual(["g", "p"]);
    expect(resolveHooks(all, "").map(e => e.id)).toEqual(["g"]);
  });
});

describe("toHookPayload", () => {
  it("wraps the command with bsc-hook and carries event + matcher", () => {
    expect(toHookPayload(mk({ name: "fmt-hook", event: "PostToolUse", matcher: "Write", command: "fmt" })))
      .toEqual({ event: "PostToolUse", matcher: "Write", command: "bsc-hook 'fmt-hook' 'fmt'" });
  });

  it("returns null when the event or command is missing", () => {
    expect(toHookPayload(mk({ event: "", command: "fmt" }))).toBeNull();
    expect(toHookPayload(mk({ event: "PostToolUse", command: "" }))).toBeNull();
  });

  it("single-quote-escapes the name and command", () => {
    expect(toHookPayload(mk({ name: "it's a hook", event: "PreToolUse", matcher: "", command: "echo 'hi'" })))
      .toEqual({ event: "PreToolUse", matcher: "", command: "bsc-hook 'it'\\''s a hook' 'echo '\\''hi'\\'''" });
  });
});

describe("catalog templates + blank", () => {
  it("maps a known hook catalog item", () => {
    expect(hookFromCatalog("Block PII")).toMatchObject({ event: "PreToolUse", matcher: "Write|Edit", enabled: false, projects: [] });
  });

  it("falls back to a blank PostToolUse hook for unknown names", () => {
    expect(hookFromCatalog("Nope")).toMatchObject({ event: "PostToolUse", command: "", name: "Nope" });
  });

  it("blankHook produces an empty PostToolUse shape", () => {
    expect(blankHook()).toMatchObject({ event: "PostToolUse", enabled: false, projects: [], command: "" });
  });

  it("maps the Session end catalog item to a Stop hook (no tool matcher)", () => {
    expect(hookFromCatalog("Session end")).toMatchObject({ event: "Stop", command: "", enabled: false, projects: [], name: "Session end" });
    expect(hookFromCatalog("Session end").matcher).toBeUndefined();
  });
});

describe("SYSTEM_HOOKS", () => {
  it("lists the always-on PreToolUse security floor (bsc-deny / bsc-confine / bsc-scope)", () => {
    expect(SYSTEM_HOOKS.map(h => h.name)).toEqual(["bsc-deny", "bsc-confine", "bsc-scope"]);
    // Every system hook is a PreToolUse floor hook with a one-line purpose.
    for (const h of SYSTEM_HOOKS) {
      expect(h.event).toBe("PreToolUse");
      expect(h.purpose.length).toBeGreaterThan(0);
    }
  });
});
