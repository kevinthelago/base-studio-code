// The authoring stages' body (#923, split from FocusedBodies.tsx #1757): the four interactive
// editor views (Purpose · Stages · Capabilities · Review & publish) over the in-progress blueprint.
import { useState } from "react";
import type { ProjectPaneData } from "@/features/planner/pane/projectPaneData";
import { PurposeView, StagesView, CapabilitiesView, PublishView } from "@/features/planner/blueprints/BlueprintAuthorViews";
import type { AuthoringWiring } from "./focusedHandlers";

/** The authoring stages' body (#923): the four interactive editor views over the in-progress
 *  blueprint, ported from the design. Holds the selected-stage cursor for the Stages editor. */
export function FocusedAuthoringBody({ bp, phaseKey, wiring }: {
  bp?: ProjectPaneData["authoredBlueprint"]; phaseKey: string; wiring?: AuthoringWiring;
}) {
  const [selStage, setSelStage] = useState<string | null>(null);
  if (!bp || !wiring) {
    return (
      <div className="empty-state">
        <span className="empty-icon">⎙</span>
        <span>As the planner designs the blueprint, it appears here.</span>
      </div>
    );
  }
  const sel = selStage ?? bp.sections?.[0]?.uid ?? null;
  const common = { bp, onChange: wiring.onChange, skillLibrary: wiring.skillLibrary, mcpLibrary: wiring.mcpLibrary };
  const view = (() => {
    switch (phaseKey) {
      case "purpose":         return <PurposeView {...common} />;
      case "bp_stages":       return <StagesView {...common} selectedUid={sel} onSelectStage={setSelStage} />;
      case "bp_capabilities": return <CapabilitiesView {...common} />;
      case "bp_review":       return <PublishView {...common} onPublish={wiring.onPublish} published={wiring.published} />;
      default:                return null;
    }
  })();
  if (!view) return null;
  // blueprints.css scopes every component rule under `.bp-page`; the focused pane has no such
  // ancestor, so the views render unstyled without this wrapper. `bpwrap` neutralizes .bp-page's
  // own page-level layout and adds the focused-pane label/spacing tweaks (#923, ported from ba.css).
  // No own padding — `.fp .pp-scroll` already pads the body (14px 16px 18px), matching every pane.
  return <div className="bp-page bpwrap">{view}</div>;
}
