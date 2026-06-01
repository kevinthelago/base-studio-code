import { describe, it, expect } from "vitest";
import { parseAuditLog, toRow, decideAudit, type AuditRecord } from "../screens/agents/auditLog";
import { resolveProfileSettings } from "../screens/agents/profileEnforcement";
import { findProfile } from "../screens/agents/agentProfiles";
import { roleCapability } from "../lib/sessionRoles";

const rec = (toolName: string, target: string): AuditRecord => ({
  ts: "2026-05-30T12:00:00.000Z",
  pane: "t0p0",
  toolName,
  target,
});

const gateOf = (id: string) => {
  const p = findProfile(id);
  if (!p) throw new Error(id);
  return resolveProfileSettings(p);
};

describe("parseAuditLog", () => {
  it("parses TSV and skips malformed lines", () => {
    const text = [
      "2026-05-30T12:00:00.000Z\tt0p0\tBash\tls -la",
      "",
      "  ",
      "2026-05-30T12:00:01.000Z\tt0p1\tEdit\tsrc/a.ts",
    ].join("\n");
    const out = parseAuditLog(text);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ pane: "t0p0", toolName: "Bash", target: "ls -la" });
  });

  it("keeps tabs inside a target intact", () => {
    const out = parseAuditLog("t\tt0p0\tBash\techo a\tb");
    expect(out[0].target).toBe("echo a\tb");
  });
});

describe("toRow", () => {
  it("classifies kind from the tool name", () => {
    expect(toRow(rec("Bash", "cargo test")).kind).toBe("cmd");
    expect(toRow(rec("Edit", "src/a.ts")).kind).toBe("tool");
    expect(toRow(rec("WebFetch", "https://x")).kind).toBe("net");
  });
});

describe("decideAudit", () => {
  it("allows Bash by default, blocks it when the role gate denies the command", () => {
    const gate = gateOf("pf_build");
    expect(decideAudit(rec("Bash", "git status"), gate)).toBe("allow");
    const planner = roleCapability("planner"); // git read-only
    expect(decideAudit(rec("Bash", "git push"), gate, planner)).toBe("block");
    expect(decideAudit(rec("Bash", "git status"), gate, planner)).toBe("allow");
  });

  it("allows an edit inside the profile's path scope, blocks a denied path", () => {
    const gate = gateOf("pf_build"); // allow src/**, tests/**; deny **/.env, .git/**
    expect(decideAudit(rec("Edit", "src/app.ts"), gate)).toBe("allow");
    expect(decideAudit(rec("Edit", ".git/config"), gate)).toBe("block");
  });

  it("blocks a tool the profile denies outright (web on sandbox)", () => {
    expect(decideAudit(rec("WebFetch", "https://x"), gateOf("pf_sandbox"))).toBe("block");
  });

  it("asks when a capability is neither explicitly allowed nor denied", () => {
    expect(decideAudit(rec("Edit", "notes.txt"), gateOf("pf_sandbox"))).toBe("ask");
  });
});
