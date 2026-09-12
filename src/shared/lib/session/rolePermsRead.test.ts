// What a session ROLE resolves to comes from Rust, and the ways it can FAIL stay distinguishable
// (`the-role-gate-is-still-derived-in-typescript-outside-the-launch`).
//
// The thing worth pinning is not that the read works — it is that nothing here can turn a role the
// answer does not carry, or a read that never ran, into a permission set. An empty capability renders
// as "denies nothing", which reads exactly like a fully permissive role.
//
// Mocks `invoke`, NOT `@/shared/lib/core/bsc`, mirroring `paneIdentityRead.test.ts`: that exercises the
// real bridge (so a change to how `bsc` propagates a non-zero exit is actually covered) and avoids
// replacing a module that is itself a record.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  readRolePerms, permsFor, deniedCommandsFor, capabilityFor, toolRulesFor,
  type RolePerms, type PermsCapability,
} from "@/shared/lib/session/rolePermsRead";

type BscPayload = { projectKey: unknown; args: string[] };

const permsCalls = (): BscPayload[] =>
  vi.mocked(invoke).mock.calls
    .filter(([cmd, payload]) => cmd === "bsc" && (payload as BscPayload | undefined)?.args?.[1] === "perms")
    .map(([, payload]) => payload as BscPayload);

const cap = (role: string, over: Partial<PermsCapability> = {}): PermsCapability => ({
  role, github: "read", git: "write", code: "write", net: "read", ui: "read", graph: "write",
  writeGlobs: [], allow: [], surfaces: null, harvestRoots: [], ...over,
});

const row = (role: string, over: Partial<RolePerms> = {}): RolePerms => ({
  capability: cap(role),
  deniedCommands: ["gh pr merge"],
  deniedTools: ["Task"],
  toolRules: { allow: [], deny: [] },
  writeScopeGlobs: [],
  restricted: false,
  surfaces: [],
  mayFileToolingRequest: false,
  ...over,
});

function reply(rows: RolePerms[]): void {
  vi.mocked(invoke).mockResolvedValue(JSON.stringify(rows) as never);
}

beforeEach(() => {
  vi.mocked(invoke).mockReset();
});

describe("the role perms read", () => {
  it("asks Rust ONCE for the whole closed role set, with the exact argv", async () => {
    reply([row("worker"), row("director"), row("designer")]);
    const table = await readRolePerms();
    expect(table?.size).toBe(3);
    // The N+1 guard. The roles are a closed set, so one call answers everything; a per-role call
    // would be a subprocess per rendered row (#3908, #3954).
    expect(permsCalls()).toHaveLength(1);
    expect(permsCalls()[0].args).toEqual(["session", "perms", "all", "--json"]);
  });

  it("keys the table by the role on the capability, so a caller can index it", async () => {
    reply([row("worker"), row("triage")]);
    const table = await readRolePerms();
    expect(permsFor(table, "worker")?.capability.git).toBe("write");
    expect([...(table?.keys() ?? [])]).toEqual(["worker", "triage"]);
  });

  it("A FAILED READ IS NULL, NOT AN EMPTY TABLE — the caller must keep its own path", async () => {
    // `bsc` REJECTS on a non-zero exit: no bridge, no bundled binary, or a `--root` holding no
    // baseline. An empty table here would tell every caller that no role denies anything.
    vi.mocked(invoke).mockRejectedValue(new Error("no bsc binary") as never);
    expect(await readRolePerms()).toBeNull();
  });

  it("distinguishes an EMPTY answer from a failed one — empty is a table, not null", async () => {
    vi.mocked(invoke).mockResolvedValue("" as never);
    const table = await readRolePerms();
    expect(table).not.toBeNull();
    expect(table?.size).toBe(0);
  });

  it("returns null rather than throwing when the answer is not JSON", async () => {
    vi.mocked(invoke).mockResolvedValue("not json at all" as never);
    expect(await readRolePerms()).toBeNull();
  });
});

describe("the accessors never fabricate a permissive default", () => {
  it("a role ABSENT from the answer is null, with nothing for a `??` to fall through to", async () => {
    reply([row("worker")]);
    const table = await readRolePerms();
    expect(permsFor(table, "director")).toBeNull();
    expect(capabilityFor(table, "director")).toBeNull();
    expect(toolRulesFor(table, "director")).toBeNull();
  });

  it("a null TABLE yields null for every lookup, not a value", () => {
    expect(permsFor(null, "worker")).toBeNull();
    expect(deniedCommandsFor(null, "worker")).toBeNull();
    expect(capabilityFor(null, "worker")).toBeNull();
    expect(toolRulesFor(null, "worker")).toBeNull();
  });

  it("an absent role is null, but DENIED-NOTHING is a real empty list", async () => {
    // The distinction the module exists for: `[]` means "denied nothing" and is a genuine answer;
    // `null` means "unknown". Collapsing them reports an unresolvable role as denied nothing.
    reply([row("debugger", { deniedCommands: [] })]);
    const table = await readRolePerms();
    expect(deniedCommandsFor(table, "debugger")).toEqual([]);
    expect(deniedCommandsFor(table, "nosuchrole")).toBeNull();
  });

  it("a null or empty role name never resolves to a row", async () => {
    reply([row("worker")]);
    const table = await readRolePerms();
    expect(permsFor(table, null)).toBeNull();
    expect(permsFor(table, undefined)).toBeNull();
    expect(permsFor(table, "")).toBeNull();
  });

  it("no-profile-style states survive: `surfaces: null` and a scoped writeGlob are kept as they came", async () => {
    reply([row("architect", {
      capability: cap("architect", { code: "none", surfaces: null, writeGlobs: ["scratch/**"] }),
      restricted: true,
    })]);
    const table = await readRolePerms();
    const c = capabilityFor(table, "architect");
    // `surfaces: null` is UNCONSTRAINED, not "reaches no surface" — conflating them inverts the meaning.
    expect(c?.surfaces).toBeNull();
    expect(c?.writeGlobs).toEqual(["scratch/**"]);
    expect(permsFor(table, "architect")?.restricted).toBe(true);
  });

  it("carries the tool rules, which are NOT the write scope", async () => {
    reply([row("documentor", {
      toolRules: { allow: ["Edit(**/*.md)"], deny: [] },
      writeScopeGlobs: ["**/*.md"],
    })]);
    const table = await readRolePerms();
    expect(toolRulesFor(table, "documentor")).toEqual({ allow: ["Edit(**/*.md)"], deny: [] });
    expect(permsFor(table, "documentor")?.writeScopeGlobs).toEqual(["**/*.md"]);
  });
});
