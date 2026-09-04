// The widget catalogue — one entry per widget NODE, mirroring `bsc_widget::WIDGETS`.
//
// A widget is a node: one toggleable UI surface and the data stream it subscribes to.
// This file is the FRONTEND half; the Rust half owns the same closed set, and
// `widgets.test.ts` asserts the two agree so neither can gain an entry alone.
//
// ── WHY THIS IS A LITERAL LIST AND NOT A LOOKUP ──────────────────────────────
// A widget id arrives from a command line, which makes it user-controlled input.
// `renderDetachedSection` is a switch over literal cases precisely so there is no
// user-controlled dispatch, and a registry keyed by id would quietly undo that —
// handing an attacker-influenced string the ability to choose what mounts.
//
// So the id selects among literal cases and nothing else. The node carries the
// metadata a person or an LLM reads (title, stream); it never carries a code path.

/** What a widget subscribes to. `none` is a real answer — a static surface — and is
 *  deliberately distinct from a stream that exists but is not arriving, which is a
 *  runtime fault the subscriber reports rather than a property of the node. */
export type WidgetStream = "lan_spectrum" | "none";

export interface WidgetDef {
  id: string;
  title: string;
  stream: WidgetStream;
}

/** Every widget node. Must match `bsc_widget::WIDGETS`; `widgets.test.ts` pins it. */
export const WIDGETS: WidgetDef[] = [
  { id: "spectrum", title: "Spectrum analyzer", stream: "lan_spectrum" },
];

/** The node for an id, or null. Never indexes and never falls back to a default —
 *  opening "some widget" because the requested one was unknown is worse than
 *  refusing, since the caller would believe they got what they asked for. */
export function widgetById(id: string): WidgetDef | null {
  return WIDGETS.find((w) => w.id === id) ?? null;
}
