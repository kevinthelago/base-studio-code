import { describe, it, expect } from "vitest";
import { buildAuditRows, filterAuditRows, auditDecisionCounts, fmtAuditTime, type AuditDisplayRow } from "./auditRows";
import type { AgentProfile } from "./agentProfiles";

const TS = "2026-05-30T18:00:00Z";

const prof = (id: string, edit: AgentProfile["tools"]["edit"]): AgentProfile => ({
  id, name: id, color: "#888", category: "user", desc: "", mode: "ask", commands: [],
  tools: { read: "allow", grep: "allow", glob: "allow", edit, write: "ask", bash: "ask", web: "ask", task: "ask" },
  paths: { allow: [], deny: [] }, net: { allow: [] },
});

describe("buildAuditRows (#1643)", () => {
  const ctx = {
    consoles: [{ id: "t0", name: "build" }],
    profiles: [prof("pf_deny", "deny")],
    paneProfiles: { t0p0: "pf_deny" },
    paneRoles: {},
  };

  it("resolves console name + profile and derives the decision per the gate", () => {
    const rows = buildAuditRows(
      [
        `${TS}\tt0p0\tBash\tnpm test`,   // Bash → allowed (no role gate)
        `${TS}\tt0p0\tEdit\tsrc/x.ts`,   // edit denied by profile → blocked
        `${TS}\tt0p0\tWrite\tsrc/y.ts`,  // write tier "ask" → asked
      ],
      ctx,
    );
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ console: "build", profileId: "pf_deny", kind: "cmd", decision: "allow" });
    expect(rows[1]).toMatchObject({ kind: "tool", target: "src/x.ts", decision: "block" });
    expect(rows[2].decision).toBe("ask");
  });

  it("falls back to a dash console + profile for an unknown pane", () => {
    const rows = buildAuditRows([`${TS}\tt9p9\tEdit\ta.ts`], ctx);
    expect(rows[0].console).toBe("—");
    expect(rows[0].profileId).toBe("—");
    expect(rows[0].decision).toBe("ask"); // no profile/role → default ask
  });

  it("skips malformed lines", () => {
    expect(buildAuditRows(["", "garbage", `${TS}\tt0p0\tBash\tls`], ctx)).toHaveLength(1);
  });
});

describe("filterAuditRows + auditDecisionCounts (#1643)", () => {
  const rows: AuditDisplayRow[] = [
    { ts: TS, console: "a", pane: "t0p0", profileId: "p", kind: "cmd", target: "x", decision: "allow" },
    { ts: TS, console: "a", pane: "t0p1", profileId: "p", kind: "tool", target: "y", decision: "block" },
    { ts: TS, console: "b", pane: "t1p0", profileId: "p", kind: "tool", target: "z", decision: "ask" },
  ];

  it("filters by decision and by console name, 'all' meaning no filter", () => {
    expect(filterAuditRows(rows, "all", "all")).toHaveLength(3);
    expect(filterAuditRows(rows, "block", "all")).toHaveLength(1);
    expect(filterAuditRows(rows, "all", "a")).toHaveLength(2);
    expect(filterAuditRows(rows, "ask", "a")).toHaveLength(0);
  });

  it("tallies decisions", () => {
    expect(auditDecisionCounts(rows)).toEqual({ allow: 1, ask: 1, block: 1 });
  });
});

describe("fmtAuditTime (#1643)", () => {
  it("passes through an unparseable timestamp", () => {
    expect(fmtAuditTime("not-a-date")).toBe("not-a-date");
  });
  it("formats an ISO timestamp without throwing", () => {
    expect(typeof fmtAuditTime(TS)).toBe("string");
  });
});
