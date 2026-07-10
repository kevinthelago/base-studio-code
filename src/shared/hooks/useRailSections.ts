// useRailSections (#2797) — the open/closed state for a left rail's collapsible sections, keyed by a
// stable section id. Sections default OPEN (the common case); toggling a key flips it. Shared so every
// graph rail (Algorithms, Teams, …) manages its sections identically. Pairs with `RailSection`.
import { useState } from "react";

export interface RailSections {
  /** Whether the section `key` is expanded (defaults to `defaultOpen`). */
  isOpen: (key: string) => boolean;
  /** Flip the section `key`. */
  toggle: (key: string) => void;
}

/** Collapsible-section open state for a rail. `defaultOpen` (default true) is the state before any
 *  toggle. See {@link RailSections}. */
export function useRailSections(defaultOpen = true): RailSections {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  return {
    isOpen: (key) => open[key] ?? defaultOpen,
    toggle: (key) => setOpen((o) => ({ ...o, [key]: !(o[key] ?? defaultOpen) })),
  };
}
