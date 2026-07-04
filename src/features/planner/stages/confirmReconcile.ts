// Confirm reconciliation (#2256) — the PURE decision behind the poll's durable-confirmation sync.
// plan.db is the durable store of which stages the user confirmed (each with a content fingerprint);
// the app-state mirrors it. Every poll tick this decides three disjoint actions from the plan.db rows,
// the live section content, and the current store set. Pure + serializable → unit-testable without
// Tauri; the poll just applies the result.

import { hashString } from "@/shared/lib/core/hashString";

/** One durable confirmation row from `bsc plan confirm list` — a stage + its confirm-time fingerprint. */
export interface ConfirmRow {
  stage: string;
  fingerprint: string;
}

export interface ConfirmReconcile {
  /** Durably-confirmed stages whose content is UNCHANGED but missing from the store — restore them
   *  (rehydrate on revisit). Applied via `markStageConfirmedLocal` (no plan.db echo). */
  rehydrate: string[];
  /** Confirmed stages whose content CHANGED since confirm — reset just these (the per-stage reset).
   *  Applied via `unconfirmPlanStage` (drops store + plan.db). */
  reset: string[];
  /** Store confirmations with no plan.db row yet — forward-migrate them into plan.db (one-time, when
   *  plan.db has none and we haven't migrated this project). */
  migrate: string[];
}

/**
 * Decide the confirm reconciliation for one poll tick.
 *
 * - When plan.db has NO rows but the store does and this project hasn't been migrated → forward-migrate
 *   the store's confirmations into plan.db (the pre-#2256 app-state-only set becomes durable).
 * - Otherwise plan.db is authoritative: a row whose live content fingerprint MATCHES is rehydrated into
 *   the store (if absent); a MISMATCH means the stage's content changed → reset just that stage.
 */
export function reconcileConfirmations(
  rows: ConfirmRow[],
  liveSections: Record<string, string>,
  storeConfirmed: Set<string>,
  migrated: boolean,
): ConfirmReconcile {
  if (rows.length === 0 && storeConfirmed.size > 0 && !migrated) {
    return { rehydrate: [], reset: [], migrate: [...storeConfirmed] };
  }
  const rehydrate: string[] = [];
  const reset: string[] = [];
  for (const { stage, fingerprint } of rows) {
    if (hashString(liveSections[stage] ?? "") === fingerprint) {
      if (!storeConfirmed.has(stage)) rehydrate.push(stage);
    } else {
      reset.push(stage);
    }
  }
  return { rehydrate, reset, migrate: [] };
}

export interface SkipReconcile {
  /** Durably-skipped stages missing from the store — restore them (rehydrate on revisit). */
  rehydrate: string[];
  /** Store skips with no plan.db row yet — forward-migrate them into plan.db (one-time). */
  migrate: string[];
}

/**
 * Decide the skipped-stage reconciliation for one poll tick (#2267). Simpler than confirmations: a
 * skip is a plain decision (no fingerprint / reset-on-change), so plan.db just needs to be the durable
 * mirror. When plan.db has NO rows but the store does and this project hasn't been migrated → forward-
 * migrate the store's skips into plan.db; otherwise restore any durable skip missing from the store.
 */
export function reconcileSkips(rows: string[], storeSkipped: Set<string>, migrated: boolean): SkipReconcile {
  if (rows.length === 0 && storeSkipped.size > 0 && !migrated) {
    return { rehydrate: [], migrate: [...storeSkipped] };
  }
  return { rehydrate: rows.filter((s) => !storeSkipped.has(s)), migrate: [] };
}

/** One section as the focused-plan derivation sees it — key + draft/confirm state. */
export interface SectionState {
  k: string;
  state: "confirmed" | "drafted" | "pending";
}

/**
 * Stages to auto-confirm when a PUBLISHED project is reopened with NO durable confirmations yet
 * (#2259 backfill for pre-#2256 projects): every **drafted** section (content present, not yet
 * confirmed). A published project's discovery sections were all confirmed to reach publish, so
 * restoring them avoids a pointless reconfirm pass on reopen. The CALLER gates this to published
 * projects with an empty confirmed set — this pure helper just picks the drafted sections. `pending`
 * (no content) sections are never backfilled (nothing was confirmed there).
 */
export function stagesToBackfill(sections: SectionState[], alreadyConfirmed: Set<string>): string[] {
  return sections.filter((s) => s.state === "drafted" && !alreadyConfirmed.has(s.k)).map((s) => s.k);
}
