// Rung-4 proof (#2570, part of #2553) — the "Sessions & console behavior" settings card authored as a
// KitNode spec (data), rendered to REAL components by KitRenderer with REAL host (store) wiring. This is
// the composition renderer's honesty check on a low-stakes host screen: the card the user sees is
// produced from a validated spec, not hand-written control JSX. Kept in its own module (not the card
// file) so the card stays component-only (react-refresh) and the spec is directly importable by tests.
import type { CardNode } from "@/shared/ui/spec";

/** The two behavior toggles + their prose, as a spec. The `bind` keys map to the store booleans the
 *  card wires (`autoResumeClaude` / `autoAdvanceOnReply`). Everything here is expressible as spec nodes,
 *  so no host "slot" (a real child component for a non-spec-able stateful bit) is needed. */
export const SESSIONS_BEHAVIOR_SPEC: CardNode = {
  kind: "card",
  title: "Sessions & console behavior",
  children: [
    { kind: "row", label: "Auto-resume Claude on restart", children: [{ kind: "toggle", bind: "autoResumeClaude" }] },
    {
      kind: "text", tone: "dim", size: "sm",
      text: "Panes that had Claude running at last shutdown relaunch it with --continue when the app reopens, restoring the prior conversation. Off means panes start at a bare bash prompt; you'd type claude yourself.",
    },
    { kind: "row", label: "Cycle to next console on reply", children: [{ kind: "toggle", bind: "autoAdvanceOnReply" }] },
    {
      kind: "text", tone: "dim", size: "sm",
      text: "When you send a response to a console, jump focus to the next one waiting in the queue (Ctrl+Shift+N cycles manually). Works while maximized.",
    },
  ],
};
