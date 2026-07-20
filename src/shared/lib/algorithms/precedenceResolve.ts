/**
 * Resolve ONE state from N independent signal sources, by a declared precedence order.
 *
 * The everyday shape of "which status is this thing in?" when several sources can each claim it at
 * once and the answer must be single-valued and stable. The ordering is DATA, not control flow: the
 * common alternative is a chain of `if` returns, where the precedence exists only in the sequence of
 * the statements and cannot be read, tested, or changed without editing the branch order.
 *
 * The first source (in order) that claims the subject wins. Sources are consulted lazily, so an
 * expensive predicate placed low in the order is not paid for when something above it already matched.
 *
 * Harvested from the Fleet page's per-worker status (#3462/#3465), where coordination signals
 * (asking / waiting / blocked) outrank the raw run/idle sample, which in turn outranks a parked
 * maintenance worker — an order chosen so a worker that needs a human is never hidden behind a
 * mechanical "running".
 */

/** One candidate state and the test that claims it. `when` is only called until one matches. */
export interface PrecedenceRule<TSubject, TState> {
  /** The state this rule resolves to when it claims the subject. */
  state: TState;
  /** Does this source claim the subject? */
  when: (subject: TSubject) => boolean;
}

/**
 * The first rule (in order) whose `when` claims `subject`, else `fallback`.
 *
 * Total by construction — a `fallback` is required rather than optional, so there is no "resolved to
 * nothing" case for a caller to forget. That matters here: the states this resolves are rendered, and
 * an undefined status is a blank badge rather than a visible problem.
 */
export function resolveByPrecedence<TSubject, TState>(
  subject: TSubject,
  rules: ReadonlyArray<PrecedenceRule<TSubject, TState>>,
  fallback: TState,
): TState {
  for (const rule of rules) {
    if (rule.when(subject)) return rule.state;
  }
  return fallback;
}

/**
 * The rules that claimed `subject`, in precedence order — every match, not just the winner.
 *
 * The winner alone answers "what is it?"; this answers "what else was true?", which is what an
 * explanation needs. A worker resolving to `running` while also matching `maintenance` is a different
 * situation from one that matches `running` only, and a UI that can say so is more use than one that
 * silently discards the runners-up.
 */
export function matchingPrecedence<TSubject, TState>(
  subject: TSubject,
  rules: ReadonlyArray<PrecedenceRule<TSubject, TState>>,
): TState[] {
  return rules.filter((r) => r.when(subject)).map((r) => r.state);
}
