// The `lan` feature's public API (#1545). Cross-feature code imports
// `@/features/lan` and nothing deeper: the internals stay free to move.
//
// The analyzer surface itself ships as a RECORD
// (src-tauri/data/components/app/features/lan/), so this barrel re-exports the
// specifier that record `provides` rather than a local file — the barrel is the
// boundary, not the storage.
export {
  SpectrumAnalyzer,
  LiveSpectrumAnalyzer,
  useLanSpectrum,
  binFrequencyMhz,
  binHeight,
  foldChannel,
  isCurrent,
  ageLabel,
  NEVER_HEARD,
  type SpectrumBins,
  type Liveness,
  type LivenessState,
} from "@/features/lan/SpectrumAnalyzer";
