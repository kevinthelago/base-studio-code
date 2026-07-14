import { describe, it, expect } from "vitest";
import {
  buildSoundGraph, layoutSoundGraph, playableCueForNode, nodeTier,
  primNodeId, voiceNodeId, cueNodeId,
} from "./soundGraph";
import { STARTER_KIT } from "./soundKits";
import type { SoundKit } from "./soundDescriptor";

describe("buildSoundGraph (#3077)", () => {
  const g = buildSoundGraph(STARTER_KIT);

  it("has a node per primitive, voice, and cue", () => {
    expect(g.nodes.filter((n) => n.kind === "primitive")).toHaveLength(STARTER_KIT.primitives.length);
    expect(g.nodes.filter((n) => n.kind === "voice")).toHaveLength(STARTER_KIT.voices.length);
    expect(g.nodes.filter((n) => n.kind === "cue")).toHaveLength(STARTER_KIT.cues.length);
  });

  it("wires composes edges Cue→Voice and Voice→Primitive", () => {
    expect(g.edges.some((e) => e.from === voiceNodeId("blip") && e.to === primNodeId("sine"))).toBe(true);
    expect(g.edges.some((e) => e.from === cueNodeId("click") && e.to === voiceNodeId("blip"))).toBe(true);
  });

  it("dedupes an edge when a cue layers the same voice twice", () => {
    const kit: SoundKit = {
      ...STARTER_KIT,
      cues: [{ id: "dbl", name: "Dbl", category: "ui", layers: [{ voice: "blip", at: 0 }, { voice: "blip", at: 0.1 }] }],
    };
    const edges = buildSoundGraph(kit).edges.filter((e) => e.from === cueNodeId("dbl") && e.to === voiceNodeId("blip"));
    expect(edges).toHaveLength(1);
  });
});

describe("nodeTier + layoutSoundGraph", () => {
  it("tiers primitives(0) < voices(1) < cues(2), laid out L→R by column", () => {
    expect([nodeTier("primitive"), nodeTier("voice"), nodeTier("cue")]).toEqual([0, 1, 2]);
    const layout = layoutSoundGraph(buildSoundGraph(STARTER_KIT));
    const primX = layout.pos.get(primNodeId("sine"))!.x;
    const voiceX = layout.pos.get(voiceNodeId("blip"))!.x;
    const cueX = layout.pos.get(cueNodeId("click"))!.x;
    expect(primX).toBeLessThan(voiceX);
    expect(voiceX).toBeLessThan(cueX);
  });
});

describe("playableCueForNode", () => {
  const g = buildSoundGraph(STARTER_KIT);
  const node = (id: string) => g.nodes.find((n) => n.id === id)!;

  it("returns the real cue for a cue node", () => {
    expect(playableCueForNode(node(cueNodeId("click")), STARTER_KIT)?.id).toBe("click");
  });

  it("returns an ephemeral single-layer cue for a voice node (hear the patch alone)", () => {
    expect(playableCueForNode(node(voiceNodeId("blip")), STARTER_KIT)?.layers).toEqual([{ voice: "blip", at: 0 }]);
  });

  it("is null for a primitive — not playable without a voice", () => {
    expect(playableCueForNode(node(primNodeId("sine")), STARTER_KIT)).toBeNull();
  });
});
