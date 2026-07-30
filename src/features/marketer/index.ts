// Marketer feature (#3145 epic, #3146–#3150) — public API barrel (#1309). Cross-feature consumers
// (a future Glance marketing band #3800, the app shell once this is mounted) import ONLY from here.
export { MarketerWorkspace } from "./MarketerWorkspace";
export { MarketerStatus } from "./MarketerStatus";

export { useMarketerStore, type MarketerState } from "./store";

export {
  newCampaign, newContentItem, canTransition, advanceStatus, dueForDispatch, contentForCampaign,
  type Campaign, type ContentItem, type ContentStatus, type ChannelKind,
  type ContentMetrics, type ResearchRef, type NewContentInput, type AdvanceResult,
} from "./lib/campaign";
export { complianceViolations, canApprove, type ComplianceViolation } from "./lib/compliance";
export { deriveChannelViews, channelKindOf, type ChannelView } from "./lib/channels";
export {
  summarizeMetrics, fmtMetric, fmtChannelReadout,
  type ChannelMetricsReadout, type CampaignMetricsSummary,
} from "./lib/metrics";
export { dispatchContent, fetchChannelMetrics, fetchCampaigns, syncContentItem, syncCampaign } from "./lib/api";
