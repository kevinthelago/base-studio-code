// The Activity table's allow/ask/block decision derives from RUST when the read resolved
// (`the-role-gate-is-still-derived-in-typescript-outside-the-launch`).
//
// `buildAuditRows` re-derived each attempt's decision from `roleCapability` + `roleWriteRules` — the
// renderer's own copy of the role gate. `bsc session perms all` carries the same chain, including the
// verbatim `Edit(<glob>)` tool rules, so the table can explain a decision using what the gate actually
// resolved rather than a parallel computation.
//
// Every case below is built so the RUST answer DISAGREES with the local one. That is deliberate: if the
// two agreed, a passing test would prove nothing about which source was consulted.
import { describe, it, expect } from "vitest";
import { buildAuditRows, type AuditRowContext } from "@/features/logs/lib/auditRows";
import type { RolePerms, RolePermsTable, PermsCapability } from "@/shared/lib/session/rolePermsRead";

const TS = "2026-09-12T09:00:00Z";

const cap = (role: string, over: Partial<PermsCapability> = {}): PermsCapability => ({
  role, github: "read", git: "write", code: "write", net: "read", ui: "read", graph: "write",
  writeGlobs: [], allow: [], surfaces: null, harvestRoots: [], ...over,
});

const table = (role: string, over: Partial<RolePerms> = {}): RolePermsTable =>
  new Map<string, RolePerms>([[role, {
    capability: cap(role),
    deniedCommands: [], deniedTools: [], toolRules: { allow: [], deny: [] },
    writeScopeGlobs: [], restricted: false, surfaces: [], mayFileToolingRequest: false,
    ...over,
  }]]);

const base = (perms?: RolePermsTable | null): AuditRowContext => ({
  consoles: [{ id: "t0", name: "build" }],
  profiles: [],
  paneProfiles: {},
  paneRoles: { t0p0: "worker" },
  ...(perms === undefined ? {} : { perms }),
});

const edit = [`${TS}\tt0p0\tEdit\tsrc/x.ts`];
const push = [`${TS}\tt0p0\tBash\tgit push`];

describe("buildAuditRows prefers the Rust-derived tool rules", () => {
  it("an Edit the RUST rules allow reads as allow, where the local derivation only asks", () => {
    // A `worker` with no assigned writeGlobs resolves to an EMPTY local allow list, so the local
    // derivation can only reach `ask`. An explicit Rust allow is therefore unambiguously the source.
    expect(buildAuditRows(edit, base())[0].decision).toBe("ask");
    const rows = buildAuditRows(edit, base(table("worker", { toolRules: { allow: ["Edit(src/**)"], deny: [] } })));
    expect(rows[0].decision).toBe("allow");
  });

  it("an Edit the RUST rules deny reads as block", () => {
    const rows = buildAuditRows(edit, base(table("worker", { toolRules: { allow: [], deny: ["Edit(src/**)"] } })));
    expect(rows[0].decision).toBe("block");
  });

  it("the RUST capability drives the command check, not the local role table", () => {
    // `worker` is locally `git: write`, so `git push` reads as allow. A Rust capability saying
    // `git: none` must flip it to block — proving the capability came from the read.
    expect(buildAuditRows(push, base())[0].decision).toBe("allow");
    const rows = buildAuditRows(push, base(table("worker", { capability: cap("worker", { git: "none" }) })));
    expect(rows[0].decision).toBe("block");
  });
});

describe("buildAuditRows falls back rather than inventing a decision", () => {
  it("a read that COULD NOT RUN keeps the local derivation", () => {
    // `readRolePerms` resolves null when the bridge or the bundled binary is absent. Rendering every
    // attempt as blocked (or as allowed) because a sidecar was missing would be a confident lie.
    expect(buildAuditRows(push, base(null))[0].decision).toBe("allow");
    expect(buildAuditRows(edit, base(null))[0].decision).toBe("ask");
  });

  it("a role the answer does not carry falls back instead of reading as denied", () => {
    const empty: RolePermsTable = new Map();
    expect(buildAuditRows(push, base(empty))[0].decision).toBe("allow");
  });

  it("still tolerates an absent log and an unknown pane", () => {
    expect(buildAuditRows(undefined, base(table("worker")))).toEqual([]);
    const rows = buildAuditRows([`${TS}\tt9p9\tEdit\ta.ts`], base(table("worker")));
    expect(rows[0].console).toBe("—");
    expect(rows[0].decision).toBe("ask"); // no role for that pane ⇒ no fabricated capability
  });
});
