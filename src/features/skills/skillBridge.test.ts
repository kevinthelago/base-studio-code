// #1338 ph2 — the global skills.db bridge + the store's hydrate / write-through cache behavior.
// Migrated to the generic `bsc` bridge (#2142): every call goes through `invoke("bsc", { projectKey,
// args, stdin? })` with `projectKey: null` (skills are global) and `bsc skill …` args; reads return
// raw stdout (a JSON string) the bridge parses, writes feed the JSON body on stdin.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { loadLibrary, pushSkill, dropSkill, pushGroup, dropGroup } from "./lib/skillBridge";
import { blankSkill, type SkillDef } from "./lib/skills";
import { useAppStore } from "@/store";

const sk = (over: Partial<SkillDef> & { id: string; name: string }): SkillDef =>
  ({ ...blankSkill(), ...over });

/** A `bsc` invoke payload the bridge sends. */
type BscPayload = { projectKey: string | null; args: string[]; stdin?: string };

/** Build a mock `invoke` that dispatches on the `bsc skill …` args, returning JSON strings for the two
 *  reads (`list --full`, `group list`) and "" for every write (`add`/`remove`). Records every call. */
function mockBsc(reads: { skills?: unknown; groups?: unknown }, calls?: BscPayload[]) {
  vi.mocked(invoke).mockImplementation(async (cmd: string, payload?: unknown) => {
    if (cmd !== "bsc") return undefined;
    const p = payload as BscPayload;
    calls?.push(p);
    const key = p.args.join(" ");
    if (key === "skill list --full") return JSON.stringify(reads.skills ?? []);
    if (key === "skill group list") return JSON.stringify(reads.groups ?? []);
    return ""; // writes (add / remove / group add / group remove)
  });
}

describe("skillBridge (#1338 → bsc #2142)", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockResolvedValue(undefined);
  });

  it("loadLibrary drives `bsc skill list --full` + `group list` and maps rows to full SkillDefs", async () => {
    const calls: BscPayload[] = [];
    mockBsc(
      {
        skills: [{ id: "s1", name: "Open PR", kind: "workflow", source: "team", desc: "d", prompt: "p", tools: ["Bash"], profiles: ["build"], projects: [], enabled: true, pinned: false }],
        groups: [{ id: "g1", name: "Grp", hue: "var(--accent)", skillIds: ["s1"] }],
      },
      calls,
    );
    const lib = await loadLibrary();
    expect(lib).not.toBeNull();
    expect(lib!.skills).toHaveLength(1);
    const s = lib!.skills[0];
    expect(s).toMatchObject({ id: "s1", name: "Open PR", enabled: true, tools: ["Bash"], prompt: "p" });
    // Telemetry is display-only and not stored in skills.db → re-defaulted to zero on the way in.
    expect(s.invocations).toBe(0);
    expect(s.trend).toEqual([]);
    expect(lib!.groups).toEqual([{ id: "g1", name: "Grp", hue: "var(--accent)", skillIds: ["s1"] }]);
    // Skills are global → projectKey null; the reads use the verified `bsc skill` args.
    expect(calls).toEqual([
      { projectKey: null, args: ["skill", "list", "--full"] },
      { projectKey: null, args: ["skill", "group", "list"] },
    ]);
  });

  it("loadLibrary tolerates sparse rows (missing fields default)", async () => {
    mockBsc({ skills: [{ id: "x", name: "Bare" }], groups: [] });
    const lib = await loadLibrary();
    expect(lib!.skills[0]).toMatchObject({ id: "x", name: "Bare", kind: "workflow", source: "first-party", enabled: false, tools: [] });
  });

  it("loadLibrary returns null when the bridge rejects (no Tauri host)", async () => {
    vi.mocked(invoke).mockRejectedValue(new Error("no command"));
    expect(await loadLibrary()).toBeNull();
  });

  it("write-through helpers drive the matching `bsc skill` verbs in order", async () => {
    const calls: BscPayload[] = [];
    mockBsc({}, calls);
    await pushSkill(sk({ id: "s1", name: "x" }));
    await dropSkill("s1");
    await pushGroup({ id: "g1", name: "G", hue: "h", skillIds: [] });
    await dropGroup("g1");
    expect(calls.map((c) => c.args)).toEqual([
      ["skill", "add"],
      ["skill", "remove", "s1"],
      ["skill", "group", "add"],
      ["skill", "group", "remove", "g1"],
    ]);
    // The upserts feed their JSON body on stdin; the removes are positional (no stdin).
    expect(JSON.parse(calls[0].stdin!)).toMatchObject({ id: "s1", name: "x" });
    expect(calls[1].stdin).toBeUndefined();
    expect(JSON.parse(calls[2].stdin!)).toMatchObject({ id: "g1", name: "G" });
    expect(calls[3].stdin).toBeUndefined();
  });

  it("write-through never throws when the bridge is absent", async () => {
    vi.mocked(invoke).mockRejectedValue(new Error("absent"));
    await expect(pushSkill(sk({ id: "s", name: "n" }))).resolves.toBeUndefined();
    await expect(dropGroup("g")).resolves.toBeUndefined();
  });
});

describe("skills store ↔ skills.db (#1338 → bsc #2142)", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockResolvedValue(undefined);
    useAppStore.setState({ skills: [], skillGroups: [] });
  });

  it("hydrateSkills replaces the library from the bridge + reconciles the packaged set", async () => {
    mockBsc({
      skills: [{ id: "user-1", name: "Mine", enabled: true }],
      groups: [{ id: "g1", name: "G", hue: "h", skillIds: [] }],
    });
    await useAppStore.getState().hydrateSkills();
    const { skills, skillGroups } = useAppStore.getState();
    expect(skills.some((s) => s.id === "user-1")).toBe(true);  // the user's db skill is preserved
    expect(skills.some((s) => s.packaged)).toBe(true);          // packaged set reconciled in from code
    expect(skillGroups).toEqual([{ id: "g1", name: "G", hue: "h", skillIds: [] }]);
  });

  it("refreshSkills re-reads the library WITHOUT pushing the set back (cheap poll, #1419)", async () => {
    const calls: BscPayload[] = [];
    mockBsc({
      skills: [{ id: "authored-now", name: "Authored", enabled: true }],
      groups: [{ id: "grp-session-acme", name: "Acme", hue: "h", skillIds: ["authored-now"] }],
    }, calls);
    await useAppStore.getState().refreshSkills();
    const { skills, skillGroups } = useAppStore.getState();
    expect(skills.some((s) => s.id === "authored-now")).toBe(true); // freshly-authored skill surfaces
    expect(skillGroups).toEqual([{ id: "grp-session-acme", name: "Acme", hue: "h", skillIds: ["authored-now"] }]);
    // The whole point vs hydrateSkills: NO write-back, so it's safe to poll on a timer.
    expect(calls.map((c) => c.args)).not.toContainEqual(["skill", "add"]);
  });

  it("hydrateSkills is a no-op (keeps the seeded set) when the bridge is unreachable", async () => {
    useAppStore.setState({ skills: [sk({ id: "keep", name: "Keep" })] });
    vi.mocked(invoke).mockRejectedValue(new Error("no host"));
    await useAppStore.getState().hydrateSkills();
    expect(useAppStore.getState().skills).toEqual([sk({ id: "keep", name: "Keep" })]);
  });

  it("addSkill / removeSkill write through to the bridge", async () => {
    const calls: BscPayload[] = [];
    mockBsc({}, calls);
    const id = useAppStore.getState().addSkill({ ...blankSkill(), name: "Authored here" });
    useAppStore.getState().removeSkill(id);
    // fire-and-forget — let the microtasks settle
    await Promise.resolve();
    await Promise.resolve();
    expect(calls.map((c) => c.args)).toEqual([
      ["skill", "add"],
      ["skill", "remove", id],
    ]);
  });

  it("addSkillGroup writes the group through to the bridge", async () => {
    const calls: BscPayload[] = [];
    mockBsc({}, calls);
    useAppStore.getState().addSkillGroup("Rendering");
    await Promise.resolve();
    expect(calls.map((c) => c.args)).toContainEqual(["skill", "group", "add"]);
  });
});
