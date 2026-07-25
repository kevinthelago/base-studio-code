// Screen-reader announcer (#3770, a11y epic #2725) — a tiny app-wide channel for pushing text into a
// live region so a screen reader speaks it. Feature-agnostic: any surface can `announce(...)`; the
// single <LiveRegion> (mounted in App) renders the current message per politeness level.
//
// Each level carries its own monotonic `seq`, bumped on every announce. LiveRegion mixes it into the
// rendered text (a trailing zero-width marker) so that two consecutive announcements of the SAME string
// still change the DOM text node — otherwise a screen reader treats it as unchanged and stays silent.
// Per-LEVEL (not global) so an assertive announce never re-fires the polite region's stale message.

import { create } from "zustand";

export interface AnnouncerState {
  /** Latest polite message (non-interrupting — queued behind whatever the reader is saying). */
  polite: string;
  /** Latest assertive message (interrupts — for the few things that truly can't wait). */
  assertive: string;
  /** Bumped on every polite / assertive announce respectively, so a repeated string re-fires. */
  politeSeq: number;
  assertiveSeq: number;
  /** Push a message to the live region. Defaults to polite; pass `assertive` for urgent status only. */
  announce: (text: string, opts?: { assertive?: boolean }) => void;
}

export const useAnnouncer = create<AnnouncerState>((set) => ({
  polite: "",
  assertive: "",
  politeSeq: 0,
  assertiveSeq: 0,
  announce: (text, opts) =>
    set((s) =>
      opts?.assertive
        ? { assertive: text, assertiveSeq: s.assertiveSeq + 1 }
        : { polite: text, politeSeq: s.politeSeq + 1 },
    ),
}));

/** Imperative announce for non-React callers (hooks/effects). Same channel as the store. */
export const announce = (text: string, opts?: { assertive?: boolean }): void =>
  useAnnouncer.getState().announce(text, opts);
