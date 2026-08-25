// Should this gate run in THIS tree? (#a-corrupt-build-artifact-has-no-recovery-path)
//
// Pure decision + a thin probe, split like `incremental-prune-plan.mjs` so the rule is testable
// without a filesystem, a network, or a running app.
//
// ## The condition being prevented
//
// Two cargos over one `target/`. On 2026-08-24 an agent ran `npm run gate` with cwd set to the MAIN
// worktree — the tree `tauri dev` owns — and that tree then produced both observed corruptions: a
// 0-byte `target/debug/bsc` (twice), and an app that failed to link for ~40 minutes with
// `undefined hidden symbol`, while `cargo check` passed the whole time.
//
// Cargo's build-directory lock serialises cargo against cargo, so this is NOT a claim that two
// cargos interleave writes. It protects nothing against a non-cargo READER of a half-written
// artifact, and a build killed under memory pressure (the box was 5.6 GiB into swap at load 18) can
// leave a partial artifact that the fingerprint then blesses. Keeping the second builder out of the
// dev tree removes the whole class rather than racing it.
//
// ## It takes BOTH signals, and neither alone is enough
//
// - "Is a dev server up?" alone is wrong, and this was caught by testing it against the live app:
//   the port is MACHINE-GLOBAL. Every worktree's gate would see 1420 listening and refuse, including
//   the nine trees `tauri dev` does not own — which would have blocked the entire fleet.
// - "Am I the main tree?" alone is wrong too: a solo maintainer gating in a quiet main tree is fine,
//   and refusing that is a daily obstruction for a risk that is not present.
//
// So it refuses only where both hold: this is the main worktree AND a dev server is live. That pair
// is exactly "the tree `tauri dev` owns, right now".
//
// KNOWN LIMIT, stated rather than papered over: if someone runs `tauri dev` from inside a LINKED
// worktree, this does not catch it — the main-tree test is what keeps the guard off the other nine
// trees, and it cannot also detect a dev server that moved. That is not the documented workflow
// (`tauri dev` runs in the main tree), and the post-build artifact assertion still catches the
// resulting corruption; this guard just would not have prevented it.

/**
 * @param {{isMainWorktree: boolean, devServerUp: boolean, override: boolean}} ctx
 * @returns {{allow: boolean, reason: string}}
 */
export function decideGateTree(ctx) {
  if (!ctx.isMainWorktree || !ctx.devServerUp) {
    return { allow: true, reason: "" };
  }
  if (ctx.override) {
    return {
      allow: true,
      reason:
        "a dev server is live in this tree — proceeding because BSC_GATE_ALLOW_DEV_TREE is set. " +
        "If the app fails to link afterwards, that is this.",
    };
  }
  return {
    allow: false,
    reason:
      "a dev server is LIVE in this tree, so `tauri dev` owns its target/ — a second cargo here is " +
      "what produced a 0-byte `bsc` and a 40-minute app link failure on 2026-08-24.\n" +
      "  Gate in a worktree instead (that is the documented workflow, and it is zero-install):\n" +
      "      git worktree add wt-<short> -b <ref> develop && cd wt-<short> && npm run gate\n" +
      "  Or, if you know the app is not building: BSC_GATE_ALLOW_DEV_TREE=1 npm run gate",
  };
}

/** The dev server's port, from `tauri.conf.json`'s `devUrl`. Read rather than hardcoded so the
 *  guard cannot drift from the config the app actually dials. Returns null when it cannot be
 *  determined, which the caller must treat as "no dev server" — a guard that cannot read its own
 *  config must not start refusing gates. */
export function devPortFrom(conf) {
  const url = conf?.build?.devUrl ?? conf?.build?.devPath ?? "";
  const m = String(url).match(/:(\d{2,5})(?:\/|$)/);
  return m ? Number(m[1]) : null;
}
