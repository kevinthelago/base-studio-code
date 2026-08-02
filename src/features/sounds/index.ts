// Public API barrel for the Sounds feature (#3072) — cross-feature consumers import ONLY from here.
export { SoundsWorkspace } from "./SoundsWorkspace";
// #4215: the graph-hosted workspace — what the planner mounts. The file component above stays exported;
// both copies coexist under the record<->file parity guard.
export { SoundsGraphHost } from "./SoundsGraphHost";
export { BUILTIN_KITS, STARTER_KIT, mergeKits } from "./lib/soundKits";
export { loadKits, pushKit, dropKit } from "./lib/soundBridge";
export { playCue, compileCue, voiceDuration, type CompiledCue, type CompiledVoice } from "./lib/synth";
export {
  validateKit, SOUND_CATEGORIES, CATEGORY_LABEL,
  type Primitive, type Voice, type Cue, type SoundKit, type SoundCategory, type Envelope,
} from "./lib/soundDescriptor";
// Cross-graph composition (#3117) — the sound-graph NodeLookup another pillar composes into its resolver,
// and the self-contained cue-player emit its preview vendors.
export { soundNodeLookup } from "./lib/crossGraphAdapter";
export { cuePlayerModule } from "./lib/cuePlayerModule";
// Consumer runtime (#3082, P4a) — opt-in app notification sounds voicing fleet coord events.
export { useNotificationSounds } from "./useNotificationSounds";
export { coordEventCue, cuesForLines, type NotifyCue } from "./lib/notifyCues";
