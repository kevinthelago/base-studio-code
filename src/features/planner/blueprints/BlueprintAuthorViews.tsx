// The four interactive Blueprint Author phase views (#923), ported from the design's
// blueprint-author/views.jsx and adapted to the current model: stages carry skills + MCP +
// output disposition (NOT pipelines — #897 removed those). Each view edits the in-progress
// blueprint and emits the whole thing via `onChange`; the planner also drives it via the
// <blueprint> tag, so editing and the live session stay in sync. Styling reuses blueprints.css.
//
// Decomposed into colocated sub-modules under `authorViews/` — this barrel keeps the public
// export surface (the four views + `authoringChecks` + `AuthorViewProps`) unchanged.

import "../../../styles/blueprints.css";

export type { AuthorViewProps } from "./authorViews/shared";
export { PurposeView } from "./authorViews/PurposeView";
export { StagesView } from "./authorViews/StagesView";
export { CapabilitiesView } from "./authorViews/CapabilitiesView";
export { PublishView, authoringChecks } from "./authorViews/PublishView";
