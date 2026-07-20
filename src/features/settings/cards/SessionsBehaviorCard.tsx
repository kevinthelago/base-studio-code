import { useAppStore } from "@/store";
import { KitRenderer } from "@/shared/ui/spec";
import { SESSIONS_BEHAVIOR_SPEC } from "./sessionsBehaviorSpec";

/**
 * Rung-4 proof (#2570): this real settings card is rendered from a node spec (`SESSIONS_BEHAVIOR_SPEC`)
 * through `KitRenderer`, wired to REAL store state — the spec's `binds` keys read the actual
 * `autoResumeClaude` / `autoAdvanceOnReply` fields out of `values`, and its `actions` names resolve to
 * the setters below. There is no hand-written control JSX; switching the underlying kit/theme never
 * touches the spec. (A stateful bit the spec vocabulary can't express would be passed as a host slot —
 * this card needs none.)
 *
 * Migrated to the general vocabulary in #3500. The write side moved from `onBind` (which inferred the
 * new value by negating the old one, only ever correct for booleans) to NAMED actions — the host states
 * what flipping the switch means, so nothing has to guess the pairing.
 */
export function SessionsBehaviorCard() {
  const {
    autoResumeClaude, setAutoResumeClaude,
    autoAdvanceOnReply, setAutoAdvanceOnReply,
  } = useAppStore();

  const values = { autoResumeClaude, autoAdvanceOnReply };
  const on = {
    toggleAutoResumeClaude: () => setAutoResumeClaude(!autoResumeClaude),
    toggleAutoAdvanceOnReply: () => setAutoAdvanceOnReply(!autoAdvanceOnReply),
  };

  return <KitRenderer node={SESSIONS_BEHAVIOR_SPEC} values={values} on={on} />;
}
