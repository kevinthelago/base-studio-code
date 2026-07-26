// Pure style atoms for the cloud-blueprint column (`list/CloudBlueprints.tsx`, #3802) — the spinner
// rotation (keyframe `bim-spin`, `styles/blueprintImport.css`) + the shared loading shimmer (#2234).
// (The per-row preview cache type + `pill` badge lived here for the removed BlueprintImportModal; they
// went with it — the not-yet-downloaded list is download-only.)

import { type CSSProperties } from "react";
// The loading shimmer is the shared skeleton style now (#2234) — one skeleton look app-wide.
export { shimmer } from "@/shared/ui/feedback/shimmer";

export const spin: CSSProperties = { animation: "bim-spin .8s linear infinite" };
