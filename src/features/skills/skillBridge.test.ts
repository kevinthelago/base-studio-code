// #1338 ph2 — the global skills.db bridge + the store's hydrate / write-through cache behavior.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { loadLibrary, pushSkill, dropSkill, pushGroup, dropGroup } from "./lib/skillBridge";
import { blankSkill, type SkillDef } from "./lib/skills";
import { useAppStore } from "@/store";

const sk = (over: Partial<SkillDef> & { id: string; name: string }): SkillDef =>
  ({ ...blankSkill(), ...over });

describe("skillBridge (#1338)", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockResolvedValue(undefined);
  });

  it("loadLibrary maps rows to full SkillDefs with zeroed telemetry", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "skill_store_list")
        return [{ id: "s1", name: "Open PR", kind: "workflow", source: "team", desc: "d", prompt: "p", tools: ["Bash"], profiles: ["build"], projects: [], enabled: true, pinned: false }];
      if (cmd === "skill_group_list")
        return [{ id: "g1", name: "Grp", hue: "var(--accent)", skillIds: ["s1"] }];
      return undefined;
    });
    const lib = await loadLibrary();
    expect(lib).not.toBeNull();
    expect(lib!.skills).toHaveLength(1);
    const s = lib!.skills[0];
    expect(s).toMatchObject({ id: "s1", name: "Open PR", enabled: true, tools: ["Bash"] });
    // Telemetry is display-only and not stored in skills.db → re-defaulted to zero on the way in.
    expect(s.invocations).toBe(0);
    expect(s.trend).toEqual([]);
    expect(lib!.groups).toEqual([{ id: "g1", name: "Grp", hue: "var(--accent)", skillIds: ["s1"] }]);
  });

  it("loadLibrary tolerates sparse rows (missing fields default)", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) =>
      cmd === "skill_store_list" ? [{ id: "x", name: "Bare" }] : []);
    const lib = await loadLibrary();
    expect(lib!.skills[0]).toMatchObject({ id: "x", name: "Bare", kind: "workflow", source: "first-party", enabled: false, tools: [] });
  });

  it("loadLibrary returns null when the bridge rejects (no Tauri host)", async () => {
    vi.mocked(invoke).mockRejectedValue(new Error("no command"));
    expect(await loadLibrary()).toBeNull();
  });

  it("write-through helpers call the matching commands in order", async () => {
    const calls: string[] = [];
    vi.mocked(invoke).mockImplementation(async (cmd: string) => { calls.push(cmd); return undefined; });
    await pushSkill(sk({ id: "s1", name: "x" }));
    await dropSkill("s1");
    await pushGroup({ id: "g1", name: "G", hue: "h", skillIds: [] });
    await dropGroup("g1");
    expect(calls).toEqual(["skill_store_upsert", "skill_store_remove", "skill_group_upsert", "skill_group_remove"]);
  });

  it("write-through never throws when the bridge is absent", async () => {
    vi.mocked(invoke).mockRejectedValue(new Error("absent"));
    await expect(pushSkill(sk({ id: "s", name: "n" }))).resolves.toBeUndefined();
    await expect(dropGroup("g")).resolves.toBeUndefined();
  });
});

describe("skills store ↔ skills.db (#1338)", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockResolvedValue(undefined);
    useAppStore.setState({ skills: [], skillGroups: [] });
  });

  it("hydrateSkills replaces the library from the bridge + reconciles the packaged set", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "skill_store_list") return [{ id: "user-1", name: "Mine", enabled: true }];
      if (cmd === "skill_group_list") return [{ id: "g1", name: "G", hue: "h", skillIds: [] }];
      return undefined;
    });
    await useAppStore.getState().hydrateSkills();
    const { skills, skillGroups } = useAppStore.getState();
    expect(skills.some((s) => s.id === "user-1")).toBe(true);  // the user's db skill is preserved
    expect(skills.some((s) => s.packaged)).toBe(true);          // packaged set reconciled in from code
    expect(skillGroups).toEqual([{ id: "g1", name: "G", hue: "h", skillIds: [] }]);
  });

  it("hydrateSkills is a no-op (keeps the seeded set) when the bridge is unreachable", async () => {
    useAppStore.setState({ skills: [sk({ id: "keep", name: "Keep" })] });
    vi.mocked(invoke).mockRejectedValue(new Error("no host"));
    await useAppStore.getState().hydrateSkills();
    expect(useAppStore.getState().skills).toEqual([sk({ id: "keep", name: "Keep" })]);
  });

  it("addSkill / removeSkill write through to the bridge", async () => {
    const calls: Array<{ cmd: string; args: unknown }> = [];
    vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => { calls.push({ cmd, args }); return undefined; });
    const id = useAppStore.getState().addSkill({ ...blankSkill(), name: "Authored here" });
    useAppStore.getState().removeSkill(id);
    // fire-and-forget — let the microtasks settle
    await Promise.resolve();
    await Promise.resolve();
    expect(calls.map((c) => c.cmd)).toEqual(["skill_store_upsert", "skill_store_remove"]);
    expect((calls[1].args as { id: string }).id).toBe(id);
  });

  it("addSkillGroup writes the group through to the bridge", async () => {
    const calls: string[] = [];
    vi.mocked(invoke).mockImplementation(async (cmd: string) => { calls.push(cmd); return undefined; });
    useAppStore.getState().addSkillGroup("Rendering");
    await Promise.resolve();
    expect(calls).toContain("skill_group_upsert");
  });
});
