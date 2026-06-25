// Helpers for determining plan readiness and surfacing the first unfinished
// section to the user (#565). Pure — no React or Tauri imports so the logic
// is independently testable and consumable from Planning.tsx.

/** Minimal section shape this helper needs; matches the Planning.tsx `Section`. */
export interface PlanSection {
  k: string;
  state: "pending" | "drafted" | "confirmed";
}

/**
 * Return the key of the first section that has not yet been confirmed, in
 * document order. Returns `null` when every section is confirmed (the plan is
 * complete and launch should be enabled).
 *
 * The Context-stage gate requires `goal`, `scope`, `stack`, and `architecture`
 * to be written and confirmed; downstream stages each add their own sections.
 * This function is stage-agnostic — it selects the first non-confirmed section
 * in whatever order the caller passes, so Planning.tsx can inject its curated
 * section order.
 */
export function firstUnfinishedSection(sections: PlanSection[]): string | null {
  for (const s of sections) {
    if (s.state !== "confirmed") return s.k;
  }
  return null;
}

/**
 * Build a human-readable helper message telling the user which section is
 * blocking the launch. Returns an empty string when there is no unfinished
 * section (launch should be enabled).
 */
export function launchBlockedMessage(firstUnfinishedKey: string | null): string {
  if (!firstUnfinishedKey) return "";
  return `Complete and confirm the "${firstUnfinishedKey}" plan section first.`;
}
