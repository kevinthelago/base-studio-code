// The session's ACCESS env, captured from the LIVE TypeScript so the Rust derivation can be proved
// equal. Three grants, each consumed by Rust and decided nowhere near it:
//
//   GH_TOKEN            whether this session gets a GitHub credential at all
//   BSC_HARVEST_ROOTS   which trees it may SCAN, read-only, outside its own repo
//   BSC_STREAM          whether `bsc plan` is scoped to one fleet stream or sees them all
//
// `crates/plandb/src/scope.rs` reads the third and scopes every plan read/write to it;
// `crates/bsc-ui/src/cli.rs` reads the second and refuses a harvest outside it; `crates/bsc-sandbox`
// records the hazard of the first crossing into a cage without ever deciding who gets one.
//
// The values come out of `buildAgentEnv` itself, so the fixture records the decision the LAUNCH makes
// rather than one recomposed from its parts.
//
//     UPDATE_FIXTURES=1 npx vitest run src/shared/lib/session/accessEnv.fixtures.gen.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { buildAgentEnv } from "@/app/console/lib/sessionLaunch";
import { roleCapability, type SessionRole } from "@/shared/lib/session/sessionRoles";
import type { AppStore } from "@/store/types";

const FIXTURE = join(process.cwd(), "src/shared/lib/session/accessEnv.fixtures.json");
const PANE = "p1";
const TOKEN = "ghp_testtoken";

const BASE = {
  deniedCommands: [], paneRoles: {}, paneRoleGlobs: {}, paneProfiles: {}, agentProfiles: [],
  paneFlows: {}, surfaceCatalog: [], fleetPaneStreams: {}, appRepoRoot: "/repo", bscBaseDir: "/base",
  mcpServers: [], skills: [], sessionSkillOverrides: {}, sessionSkillGroups: {}, skillGroups: [], paneSkills: {},
};

const ROLES: SessionRole[] = [
  "planner", "worker", "director", "triage", "tester", "reviewer",
  "issuer", "juror", "documentor", "designer", "architect", "librarian", "sound-designer", "marketer",
] as SessionRole[];

type Case = {
  label: string;
  role?: string;
  token?: string;
  stream?: string;
  appRepoRoot?: string;
  bscBaseDir?: string;
};

const SUBJECTS: Case[] = [
  ...ROLES.map((r) => ({ label: `role ${r} with a token`, role: r, token: TOKEN })),
  { label: "no role at all — an ungated pane keeps its token", token: TOKEN },
  { label: "no token supplied — nothing to place", role: "worker" },
  { label: "empty token string is falsy — nothing to place", role: "worker", token: "" },

  // BSC_STREAM: gated on the WORKER role, not merely on owning a stream.
  { label: "a WORKER owning a stream is scoped to it", role: "worker", token: TOKEN, stream: "kernel" },
  { label: "a REVIEWER owning a stream is NOT scoped — it judges across streams", role: "reviewer", token: TOKEN, stream: "kernel" },
  { label: "a JUROR owning a stream is NOT scoped", role: "juror", token: TOKEN, stream: "kernel" },
  { label: "a DIRECTOR owning a stream is NOT scoped", role: "director", token: TOKEN, stream: "kernel" },
  { label: "a worker with NO stream is unscoped", role: "worker", token: TOKEN },

  // Harvest roots: symbolic tokens resolved by the launch; unresolvable contributes nothing.
  { label: "designer resolves BOTH harvest tokens", role: "designer", token: TOKEN },
  { label: "designer with NO appRepoRoot — that token contributes nothing", role: "designer", token: TOKEN, appRepoRoot: "" },
  { label: "designer with NO bscBaseDir — the projects token contributes nothing", role: "designer", token: TOKEN, bscBaseDir: "" },
  { label: "designer with NEITHER path — the variable is unset entirely", role: "designer", token: TOKEN, appRepoRoot: "", bscBaseDir: "" },
  { label: "a worker declares no harvest roots", role: "worker", token: TOKEN },
];

const envFor = (c: Case) =>
  buildAgentEnv(
    {
      ...BASE,
      ...(c.appRepoRoot !== undefined ? { appRepoRoot: c.appRepoRoot } : {}),
      ...(c.bscBaseDir !== undefined ? { bscBaseDir: c.bscBaseDir } : {}),
      paneRoles: c.role ? { [PANE]: c.role } : {},
      fleetPaneStreams: c.stream ? { [PANE]: { id: c.stream } } : {},
    } as unknown as AppStore,
    PANE,
    "claude",
    c.token ?? "",
  ) ?? {};

describe("accessEnv fixtures", () => {
  it("captures the three access grants over every role", () => {
    const cases = SUBJECTS.map((c) => {
      const env = envFor(c);
      return {
        label: c.label,
        role: c.role ?? null,
        token: c.token ?? "",
        stream: c.stream ?? null,
        appRepoRoot: c.appRepoRoot ?? BASE.appRepoRoot,
        bscBaseDir: c.bscBaseDir ?? BASE.bscBaseDir,
        capability: c.role ? roleCapability(c.role as SessionRole, {}) ?? null : null,
        ghToken: env.GH_TOKEN ?? null,
        harvestRoots: env.BSC_HARVEST_ROOTS ?? null,
        stream_env: env.BSC_STREAM ?? null,
      };
    });
    const next = { note: "GENERATED from @/app/console/lib/sessionLaunch buildAgentEnv — do not hand-edit; see the .gen.test.ts", cases };

    if (process.env.UPDATE_FIXTURES) writeFileSync(FIXTURE, `${JSON.stringify(next, null, 2)}\n`);
    expect(existsSync(FIXTURE), `${FIXTURE} missing — run with UPDATE_FIXTURES=1`).toBe(true);
    expect(JSON.parse(readFileSync(FIXTURE, "utf8"))).toEqual(next);
  });

  it("THE CREDENTIAL GATE actually bites: some roles are refused the token and others keep it", () => {
    const withToken = ROLES.filter((r) => envFor({ label: "", role: r, token: TOKEN }).GH_TOKEN);
    const without = ROLES.filter((r) => !envFor({ label: "", role: r, token: TOKEN }).GH_TOKEN);
    expect(without.length, "no role was refused the credential — the gate would be untested").toBeGreaterThan(0);
    expect(withToken.length, "every role was refused — that cannot be right either").toBeGreaterThan(0);
    // The asymmetry worth naming: triage is git:none but github:write, so it KEEPS its token.
    expect(envFor({ label: "", role: "triage", token: TOKEN }).GH_TOKEN, "triage is github:write").toBe(TOKEN);
  });

  it("BSC_STREAM is gated on the worker ROLE, not merely on owning a stream", () => {
    expect(envFor({ label: "", role: "worker", stream: "kernel" }).BSC_STREAM).toBe("kernel");
    expect(
      envFor({ label: "", role: "reviewer", stream: "kernel" }).BSC_STREAM,
      "a reviewer judges other streams' landings and must not be boxed into one",
    ).toBeUndefined();
  });

  it("an unresolvable harvest token contributes nothing rather than widening access", () => {
    const both = envFor({ label: "", role: "designer" }).BSC_HARVEST_ROOTS;
    expect(both?.split("\n").length, "newline-separated: a Windows path contains both ; and :").toBe(2);
    expect(envFor({ label: "", role: "designer", appRepoRoot: "", bscBaseDir: "" }).BSC_HARVEST_ROOTS).toBeUndefined();
  });
});
