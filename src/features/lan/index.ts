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
  binEdgesMhz,
  binDbm,
  rampColor,
  strengthFraction,
  strengthColor,
  spanOf,
  pushRow,
  rowGradient,
  isCurrent,
  ageLabel,
  emptyStateDiagnosis,
  staleBanner,
  contributingSensors,
  NEVER_HEARD,
  HISTORY,
  MIN_RANGE_DB,
  extentOf,
  rangeDb,
  timeTicks,
  axisTicks,
  tickAnchor,
  ROW_PX,
  CHANNEL_WIDTH_MHZ,
  UNOBSERVED,
  type SpectrumBins,
  type Liveness,
  type LivenessState,
  type Row,
  type Span,
  type Extent,
  type TimeTick,
} from "@/features/lan/SpectrumAnalyzer";
