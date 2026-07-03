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
