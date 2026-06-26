// Shared readiness-check shape (#1625) — one home for the byte-identical
// `{ id, label, ok, detail }` row used by the deploy / integration / source stage
// banners. Each `*Checks` builder returns these; every row `ok` ⇒ the stage gate passes.

/** A single readiness row driving an in-pane stage banner. */
export interface ReadinessCheck {
  /** stable row id (also the React key). */
  id: string;
  /** human label for the requirement. */
  label: string;
  /** whether this requirement is satisfied. */
  ok: boolean;
  /** a short value/explanation shown beside the label. */
  detail: string;
}
