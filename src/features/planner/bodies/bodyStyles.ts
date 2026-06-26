// Shared inline-style constants for the planner focused-pane bodies (#1635).
//
// The bodies under bodies/ are token-styled inline (no CSS modules) and historically each
// re-declared the same handful of style objects. These are the ones that were byte-identical
// across multiple bodies — extracted here so there is a single source of truth.
//
// NOTE: only TRULY-identical style objects live here. ScanViews keeps its own `grpLabel`
// (fontSize 10 / letterSpacing .08em) because it differs from this one (fontSize 9.5 / .06em),
// and the per-body component helpers (Card/Field/Seg/Toggle/…) differ in props + markup between
// bodies and are deliberately NOT consolidated.

import type { CSSProperties } from "react";

/** The mono font token (`var(--mono)`), referenced inline across every planner body. */
export const MONO = "var(--mono)";

/**
 * Uppercase, dim, tracked group/section label — the standard field/section caption used by the
 * Deploy, Source, Integration, and Integrations bodies.
 */
export const grpLabel: CSSProperties = {
  fontFamily: MONO, fontSize: 9.5, color: "var(--fg-dim)", textTransform: "uppercase", letterSpacing: ".06em",
};

/** A small, dim mono caption (hints, inline meta). */
export const monoSm: CSSProperties = { fontFamily: MONO, fontSize: 10, color: "var(--fg-dim)" };
