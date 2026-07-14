// Public API barrel for the Sounds feature (#3072) — cross-feature consumers import ONLY from here.
export { SoundsWorkspace } from "./SoundsWorkspace";
export { STARTER_KIT } from "./lib/soundSeeds";
export { playCue, compileCue, voiceDuration, type CompiledCue, type CompiledVoice } from "./lib/synth";
export {
  validateKit, SOUND_CATEGORIES, CATEGORY_LABEL,
  type Primitive, type Voice, type Cue, type SoundKit, type SoundCategory, type Envelope,
} from "./lib/soundDescriptor";
