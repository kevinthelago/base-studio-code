// The `features` stage body (#4265) — the plan, and the library it should be built from, in one place.
//
// The features directive orders the planning session to CHECK THE LIBRARY BEFORE COMMISSIONING
// (`bsc graph impl list` / `bsc ui` before `bsc-commission`), yet the user watching that happen had no
// way to see the library. The component lens existed but hung off `test_ui` — a stage #4249 retired and
// no packaged blueprint carries — so it was unreachable; the algorithm lens did not exist at all.
//
// `features` is the right home because it is in EVERY packaged blueprint and it is the stage where
// reuse-vs-commission is actually decided. Two shallow levels rather than one flat switch, because
// "the plan" and "the library" are different kinds of thing: Features ⇄ Library, then Components ⇄
// Algorithms inside it.
import { useState } from "react";
import type { PlanFeature } from "@/features/planner/issues/featureList";
import { FeaturesBody } from "./FocusedFeaturesBody";
import { PlannerLibraryPane } from "./PlannerLibraryPane";
import { Box } from "@/shared/ui/layout/Box";
import { Stack } from "@/shared/ui/layout/Stack";
import { SegmentedControl } from "@/shared/ui/controls/SegmentedControl";

type View = "features" | "library";

const VIEWS: { value: View; label: string }[] = [
  { value: "features", label: "Features" },
  { value: "library", label: "Library" },
];

export function FeaturesStageBody(
  { features, projectId }: { features?: PlanFeature[]; projectId?: string },
) {
  // Opens on the plan — the library is the reference you reach for, not the default view.
  const [view, setView] = useState<View>("features");
  return (
    <Stack gap={0} style={{ flex: 1, minHeight: 0 }}>
      <Box style={{ padding: "8px 10px 0" }}>
        <SegmentedControl
          options={VIEWS.map((v) => ({ label: v.label, on: view === v.value, onClick: () => setView(v.value) }))}
        />
      </Box>
      <Box style={{ display: "flex", flex: 1, minHeight: 0, flexDirection: "column", overflow: "auto" }}>
        {view === "features"
          ? <FeaturesBody features={features} />
          : <PlannerLibraryPane projectKey={projectId} features={features} />}
      </Box>
    </Stack>
  );
}
