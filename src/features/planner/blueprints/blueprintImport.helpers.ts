// Pure style atoms + types shared by the Import-blueprint-from-gist modal and its per-row
// GistPreview (extracted from BlueprintImportModal.tsx — behavior-preserving, #2128).

import { type CSSProperties } from "react";
import { type PreviewBlueprint } from "./BlueprintModals";

export const spin: CSSProperties = { animation: "bim-spin .8s linear infinite" };
export const shimmer: CSSProperties = {
  background: "linear-gradient(90deg,var(--bg-elev) 0%,var(--bg-elev2) 50%,var(--bg-elev) 100%)",
  backgroundSize: "260px 100%", animation: "bim-shimmer 1.1s linear infinite",
};

/** A fetched blueprint-preview cache entry for a gist row (#1037). */
export type PreviewEntry = { loading?: boolean; data?: PreviewBlueprint; error?: string };

// ── shared style atoms ──
export const pill = (color: string): CSSProperties => ({
  display: "inline-flex", alignItems: "center", gap: 4, padding: "1px 7px", borderRadius: 99,
  fontFamily: "var(--mono)", fontSize: 9, lineHeight: 1.7, color,
  border: `1px solid color-mix(in oklch, ${color}, transparent 72%)`,
  background: `color-mix(in oklch, ${color}, transparent 90%)`,
});
