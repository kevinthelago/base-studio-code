// UI-activity live-focus (#2525) — the Design Studio's read side of the designer session's activity
// stream. When the designer AI mutates the kit store (`bsc ui set/remove` — component / kit / theme),
// the Rust `emit_ui_activity` appends a `ui-touch` line to `ui-activity.log`; this tails that stream
// via `bsc logs tail ui --json` (the same bridge + shape `useCoordLog` uses for coord.log), parses the
// most-recent touch, and drives it into the store (`setAiFocused`) which live-focuses the node AND
// re-hydrates the touched collection so the edit appears without a relaunch.
//
// DS-specific, so it lives in the components feature's lib (not shared/) — modeled on
// `shared/lib/fleet/coordinationLog.ts` `parseCoordLine` + `shared/lib/fleet/useCoordLog.ts`.
import { useRef } from "react";
import { bscJson } from "@/shared/lib/core/bsc";
import { usePoll } from "@/shared/hooks/usePoll";
import { useAppStore } from "@/store";

/** One parsed designer activity line: which collection + record the AI just wrote (`ui-touch`) or is
 *  inspecting (`ui-focus`, #3545), and when. */
export interface UiTouch {
  /** `"touch"` = a WRITE (`bsc ui set/remove`) → focus + re-hydrate; `"focus"` = a READ
   *  (`bsc ui get`/`preview-props`, #3545) → focus only, no re-hydrate. */
  kind: "touch" | "focus";
  /** The touched store collection — `"component"` · `"kit"` · `"theme"` (drives which hydrate re-runs). */
  collection: string;
  /** The record id written/removed/read — the node the Design Studio focuses. */
  id: string;
  /** Epoch-ms of the event (0 if the timestamp is unparseable). */
  at: number;
  /** The emitting pane (`$BSC_AUDIT_PANE`, or `?`). */
  pane: string;
}

/**
 * Parse one TSV `ui-activity.log` line into a {@link UiTouch}, or `null` if unrecognized.
 * Columns: `ts \t pane \t <ui-touch|ui-focus> \t <collection> \t <id>` (the `emit_ui_activity` /
 * `emit_ui_focus` shape).
 */
export function parseUiActivityLine(line: string): UiTouch | null {
  const cols = line.replace(/\r?\n$/, "").split("\t");
  if (cols.length < 5) return null;
  const [ts, pane, kind, collection, id] = cols;
  const evKind = kind === "ui-touch" ? "touch" : kind === "ui-focus" ? "focus" : null;
  if (!evKind || !id) return null;
  const parsed = Date.parse(ts);
  const at = Number.isFinite(parsed) ? parsed : 0;
  return { kind: evKind, collection, id, at, pane };
}

/** The most-recent parseable touch in a chronological (oldest-first) line list, or `null`. */
export function latestUiTouch(lines: string[]): UiTouch | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const touch = parseUiActivityLine(lines[i]);
    if (touch) return touch;
  }
  return null;
}

/** A stable identity for an event, so a poll only re-fires the store on a genuinely NEW one. */
const touchKey = (t: UiTouch) => `${t.at}:${t.kind}:${t.collection}:${t.id}`;

/**
 * Poll the designer activity stream while `active`, driving each NEW `ui-touch` into the store
 * (`setAiFocused`) — the Design Studio live-focus (#2525). Gated: when `active` is false (the designer
 * session isn't booted) the tick early-returns, so there's no bridge cost. Reads oldest-first (like
 * the coord log) and takes the latest touch.
 */
export function useUiActivity(active: boolean, ms = 1500): void {
  const setAiFocused = useAppStore((s) => s.setAiFocused);
  const lastRef = useRef<string>("");
  usePoll(
    async (isCancelled) => {
      if (!active) return;
      const lines = await bscJson<string[] | null>(
        null,
        ["logs", "tail", "ui", "--limit", "50", "--oldest", "--json"],
        null,
      );
      if (isCancelled() || !lines) return;
      const touch = latestUiTouch(lines);
      if (!touch) return;
      const key = touchKey(touch);
      if (key === lastRef.current) return; // already focused this event
      lastRef.current = key;
      // #3545: a WRITE (`touch`) focuses AND re-hydrates the collection (so the edit shows); a READ
      // (`focus`) drives the preview ONLY — nothing changed to reload, and this fires on every `get`.
      setAiFocused(touch.id, touch.collection, { hydrate: touch.kind === "touch" });
    },
    ms,
    [active],
  );
}
