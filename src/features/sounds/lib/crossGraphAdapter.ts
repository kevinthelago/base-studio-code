// Cross-graph adapter (#3117, epic #3114) — the Sounds feature's map from its OWN store shape (a
// `SoundKit`) onto the feature-agnostic {@link NodeLookup} the shared cross-graph resolver composes,
// mirroring the Algorithms adapter (`algorithms/lib/crossGraphAdapter.ts`, #3116). The three pillars stay
// decoupled: `shared/lib/graph/crossGraph` knows nothing about a `SoundKit`; THIS module adapts it, and the
// consumer (the Design Studio preview + component graph, `designs/lib/libraryModules.ts`) wires it via
// `makeUrnResolver`. Pure + React-free.
//
// A node URN's `kit` is, for the sound graph, a SoundKit id (`signal`) and its `id` is the in-kit node id.
// A `@bsc/sounds/<id>` import a component author writes is KIT-LESS — the consumer picks the kit (the
// DEFAULT sound kit). `<id>` names, in priority order:
//   • a CUE (the playable product; primary) → `code` is a self-contained player module (`cuePlayerModule`),
//   • else a VOICE (a playable patch) → `code` is a player module for a synthetic one-shot cue of it,
//   • else a PRIMITIVE (a raw source descriptor) → resolves but carries NO `code`, so it's not
//     importable/vendorable — mirroring an algorithm primitive (a descriptor, not code).
// A sound has no JS source, so unlike an algorithm (whose `code` is real, vendored verbatim) the `code`
// here is SYNTHESIZED at resolve time — the one place a cue becomes a runnable module.
import type { NodeLookup, ResolvedNode } from "@/shared/lib/graph/crossGraph";
import type { Cue, SoundKit } from "./soundDescriptor";
import { BUILTIN_KITS } from "./soundKits";
import { cuePlayerModule } from "./cuePlayerModule";

/** A synthetic one-shot cue wrapping a single voice — so a VOICE (a playable patch) is importable +
 *  playable exactly like a cue: its emitted `code` is a player module for this one-layer wrapper. */
function voiceAsCue(voiceId: string, name: string): Cue {
  return { id: voiceId, name, category: "ui", layers: [{ voice: voiceId, at: 0 }] };
}

/**
 * A {@link NodeLookup} over the sound library for the `sound` graph. Given a `kit` (a SoundKit id) and an
 * in-kit `id`, resolve — in priority order — a CUE, else a VOICE, else a PRIMITIVE, to its
 * {@link ResolvedNode}, or `null` on a miss. Defaults to the packaged {@link BUILTIN_KITS}; a caller can
 * pass the live-hydrated kits. The returned node's `urn`/`graph`/`kit`/`id` are placeholders —
 * `makeUrnResolver` overwrites them from the URN — so only `label`/`kind`/`code` carry through (`id` is set
 * to the matched node's id so a caller can canonicalize the URN). A cue/voice carries the vendorable player
 * module in `code`; a primitive carries none (a descriptor). A broken kit (a dangling composes edge) makes
 * the player emit throw → this returns `null` rather than letting the resolver throw.
 */
export function soundNodeLookup(kits: SoundKit[] = BUILTIN_KITS): NodeLookup {
  return (kitId: string, id: string): ResolvedNode | null => {
    const kit = kits.find((k) => k.id === kitId);
    if (!kit) return null;

    // Build a resolved node; when `playable` is supplied, synthesize its self-contained player module as
    // `code` (a throw during compile — a broken kit — collapses to a clean miss).
    const resolved = (kind: string, label: string, playable: Cue | null): ResolvedNode | null => {
      let code: string | undefined;
      if (playable) {
        try {
          code = cuePlayerModule(playable, kit);
        } catch {
          return null;
        }
      }
      return { urn: "", graph: "sound", kit: kitId, id, label, kind, code };
    };

    const cue = kit.cues.find((c) => c.id === id);
    if (cue) return resolved("cue", cue.name, cue);
    const voice = kit.voices.find((v) => v.id === id);
    if (voice) return resolved("voice", voice.name, voiceAsCue(voice.id, voice.name));
    const prim = kit.primitives.find((p) => p.id === id);
    if (prim) return resolved("primitive", prim.name, null); // a descriptor — no code, not importable
    return null;
  };
}
