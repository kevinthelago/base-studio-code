import { useAppStore } from "@/store";
import { KitRenderer } from "@/shared/ui/spec";
import { SESSIONS_BEHAVIOR_SPEC } from "./sessionsBehaviorSpec";

/**
 * Rung-4 proof (#2570): this real settings card is rendered from a KitNode spec
 * (`SESSIONS_BEHAVIOR_SPEC`) through `KitRenderer`, wired to REAL store state — the spec's `bind` keys
 * read/write the actual `autoResumeClaude` / `autoAdvanceOnReply` fields via `values`/`onBind`. There is
 * no hand-written control JSX; switching the underlying kit/theme never touches the spec. (A stateful bit
 * the spec vocabulary can't express would be passed as a host slot — this card needs none.)
 */
export function SessionsBehaviorCard() {
  const {
    autoResumeClaude, setAutoResumeClaude,
    autoAdvanceOnReply, setAutoAdvanceOnReply,
  } = useAppStore();

  const values = { autoResumeClaude, autoAdvanceOnReply };
  const onBind = (bind: string, value: unknown) => {
    if (bind === "autoResumeClaude") setAutoResumeClaude(Boolean(value));
    else if (bind === "autoAdvanceOnReply") setAutoAdvanceOnReply(Boolean(value));
  };

  return <KitRenderer node={SESSIONS_BEHAVIOR_SPEC} values={values} onBind={onBind} />;
}
