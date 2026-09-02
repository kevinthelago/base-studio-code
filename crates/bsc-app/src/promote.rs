//! Pure decision logic for promoting `develop` into the tree the app RUNS from.
//!
//! Ported from `scripts/promote-plan.mjs`. Side-effect-free — no git, no filesystem, no clock — so
//! every refusal is testable without a repository.
//!
//! Each refusal exists because the alternative is worse than stopping, and the whole point of the
//! feature is that the user's session is never disturbed by surprise.

/// What a promote run should do.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    Fail,
    Noop,
    Promote,
    Reconcile,
}

/// The decision plus the machine-readable reason the caller turns into prose.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PromotePlan {
    pub action: Action,
    pub reason: &'static str,
}

const fn plan(action: Action, reason: &'static str) -> PromotePlan {
    PromotePlan { action, reason }
}

/// Everything `plan_promote` is allowed to look at.
///
/// `ahead_content` and `ahead_adds_nothing` are what separate a REAL divergence from BOOKKEEPING —
/// see the `ahead > 0` arm. THE DEFAULTS ARE THE PESSIMISTIC ANSWER on purpose: a caller that cannot
/// ask git gets exactly the historical refusal rather than an accidental reconcile.
#[derive(Clone, Debug)]
pub struct PromoteState {
    pub tree_exists: bool,
    /// `None` for a detached HEAD.
    pub branch: Option<String>,
    /// TRACKED modifications only — see [`crate::repo::tracked_dirty`].
    pub dirty: Vec<String>,
    pub ahead: u64,
    pub behind: u64,
    /// How many of the ahead commits carry CONTENT (i.e. are not merges).
    pub ahead_content: u64,
    /// Is `git diff <merge-base> <app ref>` empty?
    pub ahead_adds_nothing: bool,
    /// The branch the APP's tree is expected to be on. `None` opts out (the testing path), which is
    /// why this is a stated field rather than a hardcoded "main" inside the check.
    pub app_branch: Option<String>,
}

impl Default for PromoteState {
    /// The malformed/empty state, which must FAIL rather than promote.
    fn default() -> Self {
        Self {
            tree_exists: false,
            branch: None,
            dirty: Vec::new(),
            ahead: 0,
            behind: 0,
            ahead_content: 0,
            ahead_adds_nothing: false,
            app_branch: Some("main".to_string()),
        }
    }
}

/// Decide what a promote run should do.
pub fn plan_promote(state: &PromoteState) -> PromotePlan {
    if !state.tree_exists {
        return plan(Action::Fail, "no-app-tree");
    }
    // A detached HEAD has no branch to fast-forward, and guessing which ref was meant is exactly the
    // kind of helpfulness that moves the running app somewhere nobody chose.
    let Some(branch) = state.branch.as_deref().filter(|b| !b.is_empty() && *b != "HEAD") else {
        return plan(Action::Fail, "detached-head");
    };
    // THE ROOT IS ON SOME OTHER BRANCH, so "promote" would fast-forward the wrong ref and say nothing.
    //
    // Every other guard here exists for the case where this surface's central assumption fails — a
    // detached HEAD, a dirty tree, a ref ahead of develop — and each one explains what it found. The
    // one assumption never checked was the one it is NAMED for: that the root is on the APP branch.
    //
    // MEASURED 2026-09-01: someone had run `git checkout -B <work-ref> develop` at the repo ROOT,
    // which the convention forbids precisely because the root is the app's tree. `branch` was
    // therefore a work branch already sitting at develop's tip, so `behind` was 0 and it reported
    // "already matches develop — nothing to promote" and exited 0. `main` was five commits back and
    // nobody was told. That failure is SILENT and GREEN, which is worse than any of the ones this
    // does catch. Reading main's position needs only the ref, not a checkout, so the check costs
    // nothing.
    if let Some(app_branch) = state.app_branch.as_deref() {
        if branch != app_branch {
            return plan(Action::Fail, "wrong-app-branch");
        }
    }
    // Someone edited the RUNNING copy. The uncommitted work is the only thing here that cannot be
    // recovered, which is why this outranks every divergence below it.
    if !state.dirty.is_empty() {
        return plan(Action::Fail, "dirty-app-tree");
    }
    // The app ref holds history develop does not, so a fast-forward is impossible.
    //
    // THERE ARE TWO WAYS TO GET HERE AND THEY WANT OPPOSITE ANSWERS. Measured 2026-08-30: `main` was
    // 17 commits ahead, every single one a MERGE commit titled "merge: develop into main", and the
    // trees were byte-identical. Nothing had been committed straight to main — the refusal's own
    // accusation was false, and it sent the reader at `git log develop..main` for a fault that was
    // not there.
    //
    // It is a doom loop, not a one-off: a hand-run `git merge --no-ff develop` puts a commit on main
    // that develop lacks, which makes the NEXT `--ff-only` impossible, which forces the next
    // promotion to be done by hand too. Seventeen times. The guard was firing on a condition its own
    // workflow created. (This surface has never produced that state: `--ff-only` moves the ref and
    // writes no commit at all.)
    //
    // So split the case on evidence rather than weakening the guard:
    //
    //   BOOKKEEPING — no ahead commit carries content, AND the app ref adds nothing beyond the MERGE
    //   BASE. Its unique commits are then merges that only re-state history develop already has, so
    //   merging it back into develop changes no file, and afterwards the app ref is an ancestor of
    //   develop and `--ff-only` works again. Provable from git, which is what makes it safe to
    //   automate rather than a judgement call.
    //
    //   REAL — anything else. A content commit on the app ref, or a merge that resolved to a tree the
    //   merge base did not have, is the fault this refusal was written for, and it still refuses with
    //   the same reason. The guard is not relaxed here; it is made PRECISE, so from now on it only
    //   fires when it is telling the truth.
    if state.ahead > 0 {
        if state.ahead_content == 0 && state.ahead_adds_nothing {
            return plan(Action::Reconcile, "app-tree-ahead-by-merges-only");
        }
        return plan(Action::Fail, "app-tree-ahead");
    }
    if state.behind == 0 {
        return plan(Action::Noop, "already-current");
    }
    plan(Action::Promote, "behind")
}

/// Precedence is deliberate and pinned by tests: a dirty tree is reported even when it is also ahead,
/// because the uncommitted work is the thing at risk and the thing the user can still lose.
pub const REFUSAL_ORDER: [&str; 4] =
    ["no-app-tree", "detached-head", "dirty-app-tree", "app-tree-ahead"];

/// One leg of a gate run, as `scripts/gate.mjs` writes it to `target/gate-result.json`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GateLeg {
    pub key: String,
    pub ok: bool,
}

/// The gate's verdict artifact. `None` anywhere means UNREADABLE, which never reads as a pass.
#[derive(Clone, Debug, Default)]
pub struct GateVerdict {
    pub finished_at_ms: Option<i64>,
    /// `None` when the artifact had no `legs` array at all — distinct from an empty one.
    pub legs: Option<Vec<GateLeg>>,
}

/// A red leg somebody has ACCOUNTED FOR, and the plan item that owns it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Explained {
    pub key: String,
    pub git_ref: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GateClassification {
    pub proceed: bool,
    pub reason: &'static str,
    pub explained: Vec<Explained>,
    pub unexplained: Vec<String>,
}

fn refuse(reason: &'static str) -> GateClassification {
    GateClassification { proceed: false, reason, explained: Vec::new(), unexplained: Vec::new() }
}

/// Can a FAILED gate still be promoted through, because every red leg is a DECLARED known-red?
///
/// `bsc work gate` already models this: a declaration explains a failure, the exit code follows
/// UNEXPLAINED reds, and the recorded result of a red leg stays `fail` regardless. `npm run promote`
/// had no such vocabulary, so one stale data file left exactly two options — refuse the promote, or
/// `--skip-gate`, which skips verifying develop ENTIRELY. MEASURED 2026-09-01: `graph-promote-check`
/// was red all day with a rotating node while the other legs were green (4127 tests), so every
/// promote that day was an unverified one. That is a real safety cost paid daily for one stale
/// record.
///
/// This closes the gap in the same shape and with the same refusals:
///
///  - **An absent verdict reads as ABSENT, never as a pass.** No artifact, unparseable, or no `legs`
///    array ⇒ `no-verdict`, and the promote refuses exactly as before.
///  - **A STALE artifact is worse than none**, because it looks authoritative. The verdict must be
///    from the run that just failed, so it must have finished at or after this run started.
///  - **A gate that failed with no red leg is never excused.** Something failed outside the legs —
///    `gate-tree-guard`, a crash, a lock — and a declaration about a leg cannot speak for it.
///  - A declaration NEVER launders the red. The caller announces each explained leg and its owning
///    item; this only decides whether the run may continue.
pub fn classify_gate_failure(
    result: Option<&GateVerdict>,
    known_red: &std::collections::HashMap<String, String>,
    started_at_ms: i64,
) -> GateClassification {
    let Some(result) = result else { return refuse("no-verdict") };
    let Some(legs) = result.legs.as_ref() else { return refuse("no-verdict") };
    match result.finished_at_ms {
        Some(finished) if finished >= started_at_ms => {}
        // Unparseable and too-old are the SAME refusal on purpose: neither is a verdict about this
        // run, and inventing a third outcome for "I could not read the timestamp" would tempt a
        // caller to treat it as milder than it is.
        _ => return refuse("stale-verdict"),
    }
    let red: Vec<&GateLeg> = legs.iter().filter(|l| !l.ok).collect();
    if red.is_empty() {
        return refuse("failed-outside-the-legs");
    }
    let mut explained = Vec::new();
    let mut unexplained = Vec::new();
    for leg in red {
        match known_red.get(&leg.key) {
            Some(git_ref) if !git_ref.is_empty() => {
                explained.push(Explained { key: leg.key.clone(), git_ref: git_ref.clone() })
            }
            _ => unexplained.push(leg.key.clone()),
        }
    }
    let proceed = unexplained.is_empty();
    GateClassification {
        proceed,
        reason: if proceed { "all-red-legs-declared" } else { "unexplained-red" },
        explained,
        unexplained,
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TreeMoved {
    pub moved: bool,
    pub reason: &'static str,
    pub before: Option<String>,
    pub after: Option<String>,
}

/// Is the gate's verdict about the tree it claims to be about?
///
/// MEASURED 2026-09-01 ~10:59, which is why this exists rather than being a precaution. A promote
/// gate compiled a transient half-merged state and reported:
///
/// ```text
/// nextest  FAIL (1.6s)
/// error: this file contains an unclosed delimiter --> crates/bsc-shot/src/lib.rs:640:49
/// ```
///
/// A file, a line, a syntax error — and entirely false. That file's brace balance is 0 at every
/// commit that ever touched it, and a re-gate minutes later passed 4127 tests. A false red here is
/// indistinguishable from a real one at the exact moment someone is deciding whether develop is safe
/// to ship, and both honest responses are bad: believe it and refuse a good promote, or learn to
/// discount it and eventually skip past a real break.
///
/// THIS CHECKS BOTH DIRECTIONS, not only the red one the incident produced. A PASS over a half-merged
/// tree is the more dangerous outcome, because it promotes on a verification of a state that never
/// existed in history and nobody will ever see again. A verdict from a moved tree is not a lenient
/// verdict or a harsh one — it is not a verdict.
///
/// `None` on either side means the HEAD could not be read, and that is treated as MOVED. A check that
/// cannot see the tree must not certify it; the cost is a re-run and the alternative is the silent
/// false confidence this whole item is about.
pub fn gate_tree_moved(before: Option<&str>, after: Option<&str>) -> TreeMoved {
    let (Some(before), Some(after)) = (before, after) else {
        return TreeMoved { moved: true, reason: "head-unreadable", before: None, after: None };
    };
    if before != after {
        return TreeMoved {
            moved: true,
            reason: "head-moved",
            before: Some(before.to_string()),
            after: Some(after.to_string()),
        };
    }
    TreeMoved { moved: false, reason: "head-stable", before: None, after: None }
}

/// What to tell the caller when the tree moved under the gate.
pub fn tree_moved_message(state: &TreeMoved, tree_path: Option<&str>) -> String {
    let where_ = tree_path.map(|p| format!(" in {p}")).unwrap_or_default();
    if state.reason == "head-unreadable" {
        return format!(
            "the gate ran, but this could not read HEAD{where_} before and after it, so there is no way to\n  \
             know whether the tree it compiled is the tree you are promoting. Treating that as UNTRUSTWORTHY\n  \
             rather than as a pass. Nothing was moved — re-run the promote."
        );
    }
    format!(
        "the gate's verdict is UNTRUSTWORTHY: HEAD{where_} moved while it ran\n    \
         {} → {}\n  \
         Another session merged into the shared integration tree mid-gate, so the gate compiled a\n  \
         transient half-merged state that exists in no commit. Its result — pass OR fail — is about a tree\n  \
         nobody has. Nothing was moved; re-run the promote now that the merge has landed.",
        state.before.as_deref().unwrap_or("?"),
        state.after.as_deref().unwrap_or("?"),
    )
}

#[cfg(test)]
mod tests {
    //! Carried over from `scripts/promote-plan.test.ts`, assertion for assertion. These cover the
    //! guards that decide whether the RUNNING app's checkout moves, so a mistake here either
    //! disturbs the user mid-session — the exact thing this feature exists to stop — or destroys
    //! uncommitted work in the app tree.
    use super::*;
    use std::collections::HashMap;

    /// The TypeScript's `state()` helper: a promotable baseline each test perturbs one field of.
    fn state() -> PromoteState {
        PromoteState {
            tree_exists: true,
            branch: Some("main".into()),
            dirty: Vec::new(),
            ahead: 0,
            behind: 3,
            ahead_content: 0,
            ahead_adds_nothing: false,
            app_branch: Some("main".into()),
        }
    }

    /// The TypeScript defaulted `aheadContent` to `ahead` — "assume every one is real". Rust has no
    /// parameter defaults, so the CALLER carries that rule; this mirrors it for the tests that set
    /// `ahead` without saying anything else, which is exactly the pessimism those tests pin.
    fn ahead(n: u64) -> PromoteState {
        PromoteState { ahead: n, ahead_content: n, ..state() }
    }

    #[test]
    fn promotes_when_the_app_tree_is_clean_and_simply_behind_develop() {
        assert_eq!(plan_promote(&state()), plan(Action::Promote, "behind"));
    }

    #[test]
    fn does_nothing_when_the_app_tree_already_matches_develop() {
        let s = PromoteState { behind: 0, ..state() };
        assert_eq!(plan_promote(&s), plan(Action::Noop, "already-current"));
    }

    #[test]
    fn refuses_when_there_is_no_app_worktree_at_all() {
        let s = PromoteState { tree_exists: false, ..state() };
        assert_eq!(plan_promote(&s).action, Action::Fail);
    }

    #[test]
    fn refuses_a_detached_head_rather_than_guessing_a_ref() {
        // Guessing which ref was meant is exactly the kind of helpfulness that moves the running app
        // somewhere nobody chose.
        let s = PromoteState { branch: Some("HEAD".into()), ..state() };
        assert_eq!(plan_promote(&s), plan(Action::Fail, "detached-head"));
        let s = PromoteState { branch: None, ..state() };
        assert_eq!(plan_promote(&s), plan(Action::Fail, "detached-head"));
    }

    #[test]
    fn refuses_when_the_root_is_on_a_branch_that_is_not_the_app_branch() {
        // The one assumption the surface is NAMED for, and the only one never checked. MEASURED
        // 2026-09-01: the repo root had been left on a work branch cut from develop, so `behind` was
        // 0 and promote reported "already matches develop" and exited 0 while `main` sat five
        // commits back. A silent, GREEN failure is worse than any refusal this already has.
        let s = PromoteState { branch: Some("a-work-branch".into()), behind: 0, ..state() };
        assert_eq!(plan_promote(&s), plan(Action::Fail, "wrong-app-branch"));
        // And it fires REGARDLESS of distance — the old bug's whole shape was `behind: 0` reading as
        // "nothing to do" when the number was about the wrong ref.
        let s = PromoteState { branch: Some("a-work-branch".into()), behind: 9, ..state() };
        assert_eq!(plan_promote(&s).reason, "wrong-app-branch");
    }

    #[test]
    fn treats_any_movement_under_the_gate_as_untrustworthy_not_just_a_dirty_tree() {
        // The tree-moved check stays, and stays UNSOUND to weaken. Three consecutive promotes each
        // gated clean and each was refused because the shared integration tree moved mid-gate; main
        // drifted from 8 commits behind to 22 during the attempts. The tempting "fix" is to accept a
        // tree that moved by COMPLETE merges and refuse only a half-merged one — but if HEAD moves
        // while the gate runs, the compiler and the test runner read files ACROSS the change, so what
        // got compiled is a mixture that exists in no commit whether or not both endpoints are clean.
        assert!(gate_tree_moved(Some("aaa"), Some("bbb")).moved);
        assert!(!gate_tree_moved(Some("aaa"), Some("aaa")).moved);
        // Unreadable is moved: not knowing whether it moved is not the same as knowing it did not.
        assert!(gate_tree_moved(None, Some("aaa")).moved);
        assert!(gate_tree_moved(Some("aaa"), None).moved);
    }

    #[test]
    fn allows_any_branch_when_app_branch_is_none() {
        // Opting out is explicit, so a caller that legitimately promotes another ref still can.
        let s = PromoteState {
            branch: Some("a-work-branch".into()),
            behind: 3,
            app_branch: None,
            ..state()
        };
        assert_eq!(plan_promote(&s).action, Action::Promote);
    }

    #[test]
    fn refuses_to_promote_over_uncommitted_work_in_the_app_tree() {
        // Promoting would either fail or carry those edits forward silently, and the uncommitted work
        // is the only thing here that cannot be recovered.
        let s = PromoteState { dirty: vec![" M src/app/App.tsx".into()], ..state() };
        assert_eq!(plan_promote(&s), plan(Action::Fail, "dirty-app-tree"));
    }

    // ── the doom loop ────────────────────────────────────────────────────────────────────────────

    #[test]
    fn reconciles_when_every_ahead_commit_is_a_merge_and_the_trees_are_identical() {
        // MEASURED: main was 17 ahead, all 17 merge commits, trees byte-identical. Nothing had been
        // committed straight to main — the old refusal's accusation was simply false, and each
        // hand-merge that caused it made the NEXT --ff-only impossible, so the loop fed itself
        // seventeen times.
        let s = PromoteState {
            ahead: 17,
            ahead_content: 0,
            ahead_adds_nothing: true,
            behind: 0,
            ..state()
        };
        assert_eq!(plan_promote(&s), plan(Action::Reconcile, "app-tree-ahead-by-merges-only"));
    }

    #[test]
    fn still_reconciles_once_develop_has_moved_ahead() {
        // THE REGRESSION, and the reason the criterion is idempotence rather than "it worked once".
        // The first version asked whether the two ref trees were IDENTICAL, which is false the moment
        // develop gains a commit — i.e. after any integration, which is every real promotion. It
        // fired only in the one state where develop had not moved since the last promote, and refused
        // in exactly the state the feature exists for. `ahead_adds_nothing` asks what the APP REF
        // contributed, so develop moving is irrelevant to it.
        let s = PromoteState {
            ahead: 18,
            ahead_content: 0,
            ahead_adds_nothing: true,
            behind: 2,
            ..state()
        };
        assert_eq!(plan_promote(&s), plan(Action::Reconcile, "app-tree-ahead-by-merges-only"));
    }

    #[test]
    fn still_refuses_a_real_content_commit_on_the_app_branch() {
        // The guard is made precise, not weaker. One content commit is enough, however many merges
        // sit beside it, because that commit is history develop genuinely does not have.
        let s = PromoteState { ahead: 17, ahead_content: 1, ahead_adds_nothing: true, ..state() };
        assert_eq!(plan_promote(&s), plan(Action::Fail, "app-tree-ahead"));
    }

    #[test]
    fn refuses_when_the_commits_look_like_merges_but_the_app_ref_added_something() {
        // A merge carries no content of its own, yet can still resolve to a tree the merge base did
        // not have — a conflict resolved by hand, or an --ours. Merging back on the commit shape
        // alone would go over that resolution and lose it silently. Both signals, or refuse.
        let s = PromoteState { ahead: 3, ahead_content: 0, ahead_adds_nothing: false, ..state() };
        assert_eq!(plan_promote(&s), plan(Action::Fail, "app-tree-ahead"));
    }

    #[test]
    fn assumes_every_ahead_commit_is_real_when_the_caller_cannot_say() {
        // The defaults are the PESSIMISTIC answer on purpose: an older caller, or one that could not
        // ask git, gets exactly the historical refusal rather than an accidental reconcile.
        assert_eq!(plan_promote(&ahead(2)), plan(Action::Fail, "app-tree-ahead"));
        let s = PromoteState { ahead_adds_nothing: true, ..ahead(2) };
        assert_eq!(plan_promote(&s), plan(Action::Fail, "app-tree-ahead"));
    }

    #[test]
    fn keeps_a_dirty_tree_ahead_of_a_reconcilable_divergence() {
        // Precedence is unchanged: uncommitted work is the thing the user can still lose, so it is
        // reported first even when the divergence beneath it would have been repairable.
        let s = PromoteState {
            dirty: vec!["M x".into()],
            ahead: 5,
            ahead_content: 0,
            ahead_adds_nothing: true,
            ..state()
        };
        assert_eq!(plan_promote(&s), plan(Action::Fail, "dirty-app-tree"));
    }

    #[test]
    fn refuses_when_the_app_branch_is_ahead_of_develop_so_no_fast_forward_exists() {
        let s = PromoteState { behind: 0, ..ahead(2) };
        assert_eq!(plan_promote(&s), plan(Action::Fail, "app-tree-ahead"));
        // ahead AND behind — diverged — is still a refusal, never a merge.
        let s = PromoteState { behind: 5, ..ahead(2) };
        assert_eq!(plan_promote(&s).action, Action::Fail);
    }

    #[test]
    fn reports_a_dirty_tree_ahead_of_an_ahead_branch_when_both_are_true() {
        // Precedence: the uncommitted work is the thing the user can still lose and the thing they
        // need told about first.
        let s = PromoteState { dirty: vec![" M x.ts".into()], ..ahead(2) };
        assert_eq!(plan_promote(&s).reason, "dirty-app-tree");
    }

    #[test]
    fn treats_only_tracked_modifications_as_dirty() {
        // `dirty` carries TRACKED modifications only. A fast-forward cannot destroy an untracked
        // file, so counting them refused every promote over 0-byte editor/shell dotfiles a tooling
        // sandbox leaves at the repo root — a guard that never lets you through is not a guard.
        let s = PromoteState { dirty: vec![" M src/app/App.tsx".into()], ..state() };
        assert_eq!(plan_promote(&s).reason, "dirty-app-tree");
        // The caller passes an untracked-free list; an empty one must promote.
        assert_eq!(plan_promote(&PromoteState { dirty: Vec::new(), ..state() }).action, Action::Promote);
    }

    #[test]
    fn never_promotes_on_a_malformed_or_empty_state() {
        // The TypeScript took `undefined` and `{}`; the Rust equivalent is the Default, which is
        // written to be the refusing state rather than a convenient one.
        assert_eq!(plan_promote(&PromoteState::default()).action, Action::Fail);
    }

    #[test]
    fn the_refusal_order_is_the_order_the_guards_actually_fire_in() {
        // REFUSAL_ORDER is documentation that can go stale; this makes it evidence. Each entry is
        // produced by a state that also satisfies every LATER entry, so the precedence is exercised
        // rather than asserted.
        let all_wrong = PromoteState {
            tree_exists: false,
            branch: None,
            dirty: vec!["M x".into()],
            ahead: 2,
            ahead_content: 2,
            ..state()
        };
        assert_eq!(plan_promote(&all_wrong).reason, REFUSAL_ORDER[0]);
        let s = PromoteState { tree_exists: true, ..all_wrong.clone() };
        assert_eq!(plan_promote(&s).reason, REFUSAL_ORDER[1]);
        let s = PromoteState { branch: Some("main".into()), ..s };
        assert_eq!(plan_promote(&s).reason, REFUSAL_ORDER[2]);
        let s = PromoteState { dirty: Vec::new(), ..s };
        assert_eq!(plan_promote(&s).reason, REFUSAL_ORDER[3]);
    }

    // ── classify_gate_failure ────────────────────────────────────────────────────────────────────
    //
    // A promote forced to choose between one stale data file and skipping ALL verification is the
    // state this closes. MEASURED 2026-09-01: `graph-promote-check` was red all day on a rotating
    // node while every other leg passed, so every promote that day went through `--skip-gate` —
    // which does not skip that leg, it skips verifying develop entirely.

    /// 2026-09-01T15:00:00Z, verified against python `datetime` and `date -u -d` rather than
    /// hand-computed — the first draft of this constant was three days out.
    const STARTED: i64 = 1_788_274_800_000;
    /// 2026-09-01T15:04:00Z — four minutes into the run.
    const FINISHED: i64 = STARTED + 240_000;

    fn declared() -> HashMap<String, String> {
        HashMap::from([(
            "graph-promote-check".to_string(),
            "develop-is-red-the-repo-graph-store-is-behind".to_string(),
        )])
    }

    fn legs(red: &[&str]) -> Option<Vec<GateLeg>> {
        Some(
            ["typecheck", "lint", "vitest", "clippy", "nextest", "graph-promote-check"]
                .iter()
                .map(|k| GateLeg { key: k.to_string(), ok: !red.contains(k) })
                .collect(),
        )
    }

    fn verdict(red: &[&str]) -> GateVerdict {
        GateVerdict { finished_at_ms: Some(FINISHED), legs: legs(red) }
    }

    #[test]
    fn proceeds_when_every_red_leg_is_declared_and_names_the_owning_item() {
        let v = classify_gate_failure(Some(&verdict(&["graph-promote-check"])), &declared(), STARTED);
        assert!(v.proceed);
        assert_eq!(v.reason, "all-red-legs-declared");
        assert_eq!(
            v.explained,
            vec![Explained {
                key: "graph-promote-check".into(),
                git_ref: "develop-is-red-the-repo-graph-store-is-behind".into()
            }]
        );
        assert!(v.unexplained.is_empty());
    }

    #[test]
    fn refuses_when_any_red_leg_is_undeclared_even_alongside_a_declared_one() {
        let v = classify_gate_failure(
            Some(&verdict(&["graph-promote-check", "nextest"])),
            &declared(),
            STARTED,
        );
        assert!(!v.proceed);
        assert_eq!(v.reason, "unexplained-red");
        assert_eq!(v.unexplained, vec!["nextest"]);
    }

    #[test]
    fn refuses_with_nothing_declared_at_all() {
        // The safe direction when the store cannot be read.
        let v = classify_gate_failure(Some(&verdict(&["graph-promote-check"])), &HashMap::new(), STARTED);
        assert!(!v.proceed);
        assert_eq!(v.unexplained, vec!["graph-promote-check"]);
    }

    #[test]
    fn refuses_when_there_is_no_readable_verdict() {
        // An absent verdict reads as ABSENT, never as a pass — the same rule `bsc work gate` states.
        assert_eq!(classify_gate_failure(None, &declared(), STARTED).reason, "no-verdict");
        let no_legs = GateVerdict { finished_at_ms: Some(FINISHED), legs: None };
        assert_eq!(classify_gate_failure(Some(&no_legs), &declared(), STARTED).reason, "no-verdict");
    }

    #[test]
    fn refuses_a_verdict_that_predates_this_run() {
        // A stale artifact is worse than none, because it looks authoritative.
        let stale = GateVerdict {
            finished_at_ms: Some(STARTED - 1000),
            legs: legs(&["graph-promote-check"]),
        };
        let v = classify_gate_failure(Some(&stale), &declared(), STARTED);
        assert!(!v.proceed);
        assert_eq!(v.reason, "stale-verdict");
    }

    #[test]
    fn refuses_a_verdict_with_no_parseable_finish_time_rather_than_assuming_it_is_this_one() {
        let no_time = GateVerdict { finished_at_ms: None, legs: legs(&["graph-promote-check"]) };
        assert_eq!(classify_gate_failure(Some(&no_time), &declared(), STARTED).reason, "stale-verdict");
    }

    #[test]
    fn never_excuses_a_failure_that_no_leg_accounts_for() {
        // The gate failed AROUND the legs — a lock, a crash, gate-tree-guard. No declaration covers
        // that, because a declaration is about a leg.
        let v = classify_gate_failure(Some(&verdict(&[])), &declared(), STARTED);
        assert!(!v.proceed);
        assert_eq!(v.reason, "failed-outside-the-legs");
    }

    #[test]
    fn reports_the_declared_leg_as_red_rather_than_dropping_it_from_the_account() {
        // A declaration explains a failure; it never launders one.
        let v = classify_gate_failure(Some(&verdict(&["graph-promote-check"])), &declared(), STARTED);
        assert_eq!(v.explained.len(), 1);
        assert_eq!(v.explained[0].key, "graph-promote-check");
    }

    #[test]
    fn a_declaration_with_no_owning_item_does_not_launder_the_red() {
        // ADDED AFTER A BITE PROBE FOUND NO BITE, and it turned out to be a CORPUS GAP rather than
        // redundant code — the separating input is a declaration whose `ref` is the EMPTY STRING.
        //
        // That is reachable, not hypothetical: `bsc work known-red add <leg>` with no `--ref` stores
        // `owner = args.ref.unwrap_or("")` (crates/bsc-work/src/cli.rs). If an empty owner counted as
        // a declaration, anyone could silence a red leg without naming an item that owns it — which
        // is precisely the laundering the whole known-red design refuses. The JavaScript agreed by
        // accident (`if (ref)` is falsy on ""); here it is agreed on purpose.
        let unowned = HashMap::from([("graph-promote-check".to_string(), String::new())]);
        let v = classify_gate_failure(Some(&verdict(&["graph-promote-check"])), &unowned, STARTED);
        assert!(!v.proceed, "an unowned declaration must not let the promote through");
        assert_eq!(v.reason, "unexplained-red");
        assert_eq!(v.unexplained, vec!["graph-promote-check"]);
        assert!(v.explained.is_empty(), "and it is not reported as explained either");
    }

    #[test]
    fn a_verdict_finishing_exactly_when_the_run_started_is_this_run() {
        // The boundary the `<` vs `<=` choice turns on, pinned so a future edit cannot quietly make
        // the freshness test exclusive and start refusing a legitimate fast gate.
        let edge = GateVerdict { finished_at_ms: Some(STARTED), legs: legs(&["graph-promote-check"]) };
        assert_eq!(classify_gate_failure(Some(&edge), &declared(), STARTED).reason, "all-red-legs-declared");
    }

    // ── gate_tree_moved ──────────────────────────────────────────────────────────────────────────

    #[test]
    fn trusts_a_verdict_when_head_did_not_move() {
        let v = gate_tree_moved(Some("abc123"), Some("abc123"));
        assert!(!v.moved);
        assert_eq!(v.reason, "head-stable");
    }

    #[test]
    fn distrusts_a_verdict_when_a_merge_landed_mid_gate() {
        let v = gate_tree_moved(Some("abc123"), Some("def456"));
        assert!(v.moved);
        assert_eq!(v.reason, "head-moved");
    }

    #[test]
    fn treats_an_unreadable_head_as_moved_rather_than_as_stable() {
        // A check that cannot see the tree must not certify it. The cost is a re-run; the alternative
        // is exactly the silent false confidence this exists to remove.
        assert_eq!(gate_tree_moved(None, Some("def456")).reason, "head-unreadable");
        assert_eq!(gate_tree_moved(Some("abc123"), None).reason, "head-unreadable");
        assert!(gate_tree_moved(None, None).moved);
    }

    #[test]
    fn is_a_statement_about_the_tree_not_about_the_verdicts_colour() {
        // The direction the incident did NOT produce, and the more dangerous one: a PASS over a
        // half-merged tree promotes on a verification of a state that exists in no commit.
        // `gate_tree_moved` is asked before the verdict's colour is known, so both are covered by
        // construction.
        assert!(gate_tree_moved(Some("abc"), Some("def")).moved);
        assert!(!gate_tree_moved(Some("abc"), Some("abc")).moved);
    }

    #[test]
    fn names_both_shas_and_says_nothing_was_moved_so_the_reader_knows_to_re_run() {
        let msg = tree_moved_message(
            &gate_tree_moved(Some("abc123"), Some("def456")),
            Some("/repo/wt-integrate"),
        );
        for want in ["UNTRUSTWORTHY", "abc123", "def456", "/repo/wt-integrate", "Nothing was moved", "re-run"] {
            assert!(msg.contains(want), "message is missing {want:?}:\n{msg}");
        }
    }

    #[test]
    fn says_which_of_the_two_cases_it_is_rather_than_one_message_for_both() {
        let unreadable = tree_moved_message(&gate_tree_moved(None, None), Some("/repo/wt-integrate"));
        assert!(unreadable.contains("could not read HEAD"));
        assert!(!unreadable.contains("moved while it ran"));
    }
}
