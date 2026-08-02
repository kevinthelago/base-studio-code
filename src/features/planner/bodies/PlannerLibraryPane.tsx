// The project planner's LIBRARY surface (#4265) — both halves of what the platform builds from, in one
// dock: components (the Design Studio's kit lens) and algorithms (the knowledge-graph lens).
//
// Why both, and why here. The two studios split the whole artifact surface, and the planner already
// routes features on exactly that line — a component is UI (designer, `bsc ui`); an algorithm is
// computation (librarian, `bsc graph impl`). The features directive orders the session to CHECK THE
// LIBRARY BEFORE COMMISSIONING; until now the user could not see that library while it happened. The
// component lens existed but was orphaned (it hung off `test_ui`, a stage #4249 retired and no
// blueprint carries), and the algorithm lens did not exist at all.
//
// Cross-feature imports go through the BARRELS (`@/features/designs`, `@/features/algorithms`), never a
// deep path — this composes two features and owns neither.
import { useState } from "react";
import { PlannerComponentsPane } from "@/features/designs";
import { PlannerAlgorithmsPane } from "@/features/algorithms";
import { Box } from "@/shared/ui/layout/Box";
import { Stack } from "@/shared/ui/layout/Stack";
import { SegmentedControl } from "@/shared/ui/controls/SegmentedControl";

/** Which library the dock is showing. */
export type LibraryTab = "components" | "algorithms";

const TABS: { value: LibraryTab; label: string }[] = [
  { value: "components", label: "Components" },
  { value: "algorithms", label: "Algorithms" },
];

/**
 * @param initial — which half opens first. Defaults to components (the pre-existing surface), so the
 *   change is additive for anyone who knew where the kit lens lived.
 */
export function PlannerLibraryPane({ initial = "components" }: { initial?: LibraryTab } = {}) {
  const [tab, setTab] = useState<LibraryTab>(initial);
  return (
    <Stack gap={0} style={{ flex: 1, minHeight: 0 }}>
      <Box style={{ padding: "8px 10px 0" }}>
        <SegmentedControl
          options={TABS.map((t) => ({ label: t.label, on: tab === t.value, onClick: () => setTab(t.value) }))}
        />
      </Box>
      {/* Only the active half mounts: the components pane assembles specimens and the algorithms pane
          polls the live graph, so keeping both alive would pay for a surface nobody is looking at. */}
      <Box style={{ display: "flex", flex: 1, minHeight: 0, flexDirection: "column" }}>
        {tab === "components" ? <PlannerComponentsPane /> : <PlannerAlgorithmsPane />}
      </Box>
    </Stack>
  );
}
