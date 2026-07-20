// Rung-4 proof (#2570, part of #2553) — the "Sessions & console behavior" settings card authored as a
// node spec (data), rendered to REAL components by KitRenderer with REAL host (store) wiring. This is
// the composition renderer's honesty check on a low-stakes host screen: the card the user sees is
// produced from a validated spec, not hand-written control JSX. Kept in its own module (not the card
// file) so the card stays component-only (react-refresh) and the spec is directly importable by tests.
//
// Migrated to the GENERAL node vocabulary in #3500 — the closed set of hardcoded kinds is gone, so this
// spec now names REAL primitives (`Card`/`Row`/`Text`/`Toggle`) and every prop it sets is one the
// manifest declares. Three things the `toggle` kind did invisibly are now written down:
//   - `binds` reads the store boolean INTO `on` (was a hardcoded `ctx.values[bind]` read);
//   - `actions` names the host callback that writes it back (was a derived `onBind(bind, !isOn)` —
//     deriving the write required the renderer to know `on` pairs with `onClick`, a pairing the
//     manifest never declared, so the host now exposes the intent as a named action);
//   - `role`/`ariaChecked` are stated, not injected — the accessible-switch semantics are part of the
//     spec rather than a favour the renderer did for one kind.
import type { GeneralNode } from "@/shared/ui/spec";

/** One labelled toggle row: prose on the left, the bound switch on the right — the layout the legacy
 *  `row` + `toggle` kinds hardcoded, now stated as the primitives it always rendered. `ariaChecked`
 *  binds to the SAME state key as `on` so the accessible state can never drift from the visual one. */
function toggleRow(label: string, stateKey: string, action: string): GeneralNode {
  return {
    type: "Row",
    props: { gap: "sm", justify: "between" },
    children: [
      { type: "Text", children: label },
      {
        type: "Toggle",
        props: { role: "switch" },
        binds: { on: stateKey, ariaChecked: stateKey },
        actions: { onClick: action },
      },
    ],
  };
}

/** Body prose under a row — the dim/small treatment the legacy `text` kind applied. */
function note(text: string): GeneralNode {
  return { type: "Text", props: { tone: "dim", size: "sm" }, children: text };
}

/** The two behavior toggles + their prose, as a spec. The `binds` keys are the store booleans the card
 *  wires (`autoResumeClaude` / `autoAdvanceOnReply`); the `actions` names are the host callbacks that
 *  flip them. Everything here is expressible as spec nodes, so no host "slot" is needed. */
export const SESSIONS_BEHAVIOR_SPEC: GeneralNode = {
  type: "Card",
  props: { title: "Sessions & console behavior" },
  children: [
    {
      type: "Stack",
      props: { gap: "sm" },
      children: [
        toggleRow("Auto-resume Claude on restart", "autoResumeClaude", "toggleAutoResumeClaude"),
        note(
          "Panes that had Claude running at last shutdown relaunch it with --continue when the app reopens, restoring the prior conversation. Off means panes start at a bare bash prompt; you'd type claude yourself.",
        ),
        toggleRow("Cycle to next console on reply", "autoAdvanceOnReply", "toggleAutoAdvanceOnReply"),
        note(
          "When you send a response to a console, jump focus to the next one waiting in the queue (Ctrl+Shift+N cycles manually). Works while maximized.",
        ),
      ],
    },
  ],
};
