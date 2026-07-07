// usePageSelection — the Pages-tier internal selection hook (#2505): the controlled/uncontrolled
// selection idiom the Layouts tier established (Tree/Sequence — controlled when the `selectedId`
// prop is PRESENT, may be null = none; else internal state seeded by `defaultSelectedId`), extracted
// once so the five selecting pages don't re-implement it.
import { useState } from "react";

export interface PageSelection {
  /** The live selected id — the prop when controlled, internal state otherwise. */
  selected: string | null;
  /** Select an id: updates internal state when uncontrolled; always notifies `onSelect`. */
  select: (id: string) => void;
}

export function usePageSelection(
  selectedId: string | null | undefined,
  defaultSelectedId: string | undefined,
  onSelect?: (id: string) => void,
): PageSelection {
  const [inner, setInner] = useState<string | null>(defaultSelectedId ?? null);
  const controlled = selectedId !== undefined;
  const selected = controlled ? selectedId : inner;
  const select = (id: string) => {
    if (!controlled) setInner(id);
    onSelect?.(id);
  };
  return { selected, select };
}
