// #3412 — `@bsc/sounds/…` resolution follows the blueprint's soundKit PIN, not the first packaged built-in.
//
// The failure this locks down is INAUDIBLE by nature: before #3412 a pinned project's components played the
// STARTER kit's cues while the picker reported the pin as applied. So these tests assert the two halves that
// make the pin real — the pin becomes the resolution target, and every way it can fail is LOUD (never a
// quiet degrade to the starter kit, which the user could not hear).
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/shared/lib/core/bsc", () => ({
  bsc: vi.fn(async () => ""),
  bscJson: vi.fn(async (_k: unknown, _a: unknown, fallback: unknown) => fallback),
  bscRun: vi.fn(async () => undefined),
  bscWrite: vi.fn(async () => undefined),
}));

import { bsc } from "@/shared/lib/core/bsc";
import type { SoundKit } from "@/features/sounds";
import type { BlueprintSoundKit } from "@/features/planner/stages/blueprints";
import { makeLibraryResolvers, resolveLibrarySpec, libraryModuleResolver, DEFAULT_SOUND_KIT } from "./libraryModules";
import { selectSoundKit } from "./soundKitSelection";

const mockBsc = vi.mocked(bsc);

/** A pinned kit whose cue id (`zap`) exists in NO packaged built-in — so any resolution of it proves the
 *  pin was consulted, and any resolution of `click` (starter-only) proves it was not. */
const NEON: SoundKit = {
  id: "acme/neon",
  name: "Neon",
  primitives: [{ id: "saw", name: "Saw", kind: "osc", waveform: "sawtooth" }],
  voices: [
    { id: "buzz", name: "Buzz", primitive: "saw", freq: 440, gain: 0.3,
      env: { attack: 0.001, decay: 0.05, sustain: 0, release: 0.03 } },
  ],
  cues: [{ id: "zap", name: "Zap", category: "ui", layers: [{ voice: "buzz", at: 0 }] }],
};

const PIN: BlueprintSoundKit = { id: "acme/neon", version: "1.2.0", hash: "abc" };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("selectSoundKit — pin → selection (#3412)", () => {
  it("no pin ⇒ the packaged default, with NO store read", async () => {
    expect(await selectSoundKit(undefined)).toBe(DEFAULT_SOUND_KIT);
    expect(mockBsc).not.toHaveBeenCalled();
  });

  it("reads the pinned artifact out of the release store by id@version", async () => {
    mockBsc.mockResolvedValueOnce(JSON.stringify(NEON));
    const sel = await selectSoundKit(PIN);
    expect(mockBsc).toHaveBeenCalledWith(null, ["sound", "release", "get", "acme/neon@1.2.0", "--artifact"]);
    expect(sel.kind).toBe("pinned");
    if (sel.kind === "pinned") expect(sel.kit.id).toBe("acme/neon");
  });

  // The four ways a pin can fail. EVERY one is `unresolved` — never `default`, which would silently sound
  // like the starter kit (see the module header).
  it.each([
    ["the store does not hold the ref", async () => "null"],
    ["the store returns nothing", async () => ""],
    ["the artifact is not JSON", async () => "{not json"],
    ["the artifact is not a kit", async () => JSON.stringify({ id: "x", cues: [] })],
  ])("%s ⇒ unresolved, never a starter degrade", async (_label, out) => {
    mockBsc.mockImplementationOnce(out);
    const sel = await selectSoundKit(PIN);
    expect(sel.kind).toBe("unresolved");
    if (sel.kind === "unresolved") expect(sel.ref).toBe("acme/neon@1.2.0");
  });

  it("a bridge rejection is unresolved, not a throw (one code path for callers)", async () => {
    mockBsc.mockRejectedValueOnce(new Error("bridge absent"));
    const sel = await selectSoundKit(PIN);
    expect(sel.kind).toBe("unresolved");
  });

  it("a structurally invalid kit (a cue layering a missing voice) is unresolved", async () => {
    const broken: SoundKit = { ...NEON, voices: [] }; // its cue still layers the now-missing `buzz` voice
    mockBsc.mockResolvedValueOnce(JSON.stringify(broken));
    const sel = await selectSoundKit(PIN);
    expect(sel.kind).toBe("unresolved");
    if (sel.kind === "unresolved") expect(sel.error).toContain("structurally invalid");
  });
});

describe("makeLibraryResolvers — the pin IS the resolution target (#3412)", () => {
  it("resolves the PINNED kit's cue and NOT a cue only the packaged default carries", () => {
    const { resolveLibrarySpec: resolve } = makeLibraryResolvers({ kind: "pinned", ref: "acme/neon@1.2.0", kit: NEON });
    const zap = resolve("@bsc/sounds/zap");
    expect(zap).not.toBeNull();
    expect(zap!.kit).toBe("acme/neon");
    expect(zap!.urn).toBe("sound:acme/neon/zap");
    expect(zap!.code).toContain("export function play");
    // No cross-kit bleed: a kit is adopted WHOLESALE, so a cue the pin lacks must miss rather than fall
    // through to the starter kit's version of it.
    expect(resolve("@bsc/sounds/click")).toBeNull();
  });

  it("an UNRESOLVED pin resolves no sound at all — loud, never the starter kit", () => {
    const { resolveLibrarySpec: resolve, libraryModuleResolver: mod } = makeLibraryResolvers({
      kind: "unresolved", ref: "acme/neon@1.2.0", error: "not in the store",
    });
    expect(resolve("@bsc/sounds/click")).toBeNull(); // the starter cue does NOT sneak back in
    expect(resolve("@bsc/sounds/zap")).toBeNull();
    expect(mod("@bsc/sounds/click")).toBeNull(); // …so the import fails and graph-health flags it
    // Algorithms are a different graph and stay resolvable — a broken sound pin is not a total outage.
    expect(resolve("@bsc/algorithms/fibonacci")).not.toBeNull();
  });

  it("no pin is byte-identical to the default module-level resolvers (the unchanged-when-unpinned rule)", () => {
    const { resolveLibrarySpec: resolve, libraryModuleResolver: mod } = makeLibraryResolvers(DEFAULT_SOUND_KIT);
    for (const spec of [
      "@bsc/sounds/click", "@bsc/sounds/blip", "@bsc/sounds/sine", "@bsc/sounds/nope",
      "@bsc/algorithms/fibonacci", "@bsc/algorithms/nope", "@bsc/ui/Sparkline", "d3",
    ]) {
      expect(resolve(spec)).toEqual(resolveLibrarySpec(spec));
      expect(mod(spec)).toEqual(libraryModuleResolver(spec));
    }
  });

  it("defaults to the packaged kit when called with no selection at all", () => {
    expect(makeLibraryResolvers().resolveLibrarySpec("@bsc/sounds/click")).toEqual(resolveLibrarySpec("@bsc/sounds/click"));
  });
});
