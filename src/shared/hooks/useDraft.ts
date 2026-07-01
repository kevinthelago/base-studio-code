// useDraft (#1824) — the selection + draft-editor state every list+detail surface hand-rolls.
// One `selectedId`/`draft` pair drives a `<Pane>`: selecting an existing item edits it through to
// the store; starting a draft edits an in-memory copy until committed. Pairs with `<Pane>`.
//
//   const d = useDraft<Skill>({ items: skills, newDraft, onUpdate: updateSkill, onCreate });
//   d.selected   // draft ?? items.find(selectedId)   — the item the pane is editing (or null)
//   d.isDraft    // editing an uncommitted new item
//   d.select(id) // open an existing item (clears any draft)
//   d.startDraft()       // begin a new item (requires `newDraft`)
//   d.patch(partial)     // draft → in-memory merge; existing → onUpdate(id, partial)
//   d.commit()           // draft → onCreate(draft) then select the new id (requires `onCreate`)
//   d.close()            // clear selection + draft
import { useCallback, useState } from "react";

export interface UseDraftOptions<T extends { id: string }> {
  /** The live list of committed items (from the store). */
  items: T[];
  /** Factory for a fresh draft (with a sentinel id). Omit for selection-only surfaces. */
  newDraft?: () => T;
  /** Patch an existing committed item in the store. */
  onUpdate: (id: string, patch: Partial<T>) => void;
  /** Commit a draft → returns the new item's id. Required for `startDraft`/`commit`. */
  onCreate?: (draft: T) => string;
}

export interface Draft<T extends { id: string }> {
  selectedId: string | null;
  /** The draft, else the selected committed item, else null. */
  selected: T | null;
  isDraft: boolean;
  select: (id: string | null) => void;
  startDraft: () => void;
  patch: (patch: Partial<T>) => void;
  commit: () => void;
  close: () => void;
}

export function useDraft<T extends { id: string }>({ items, newDraft, onUpdate, onCreate }: UseDraftOptions<T>): Draft<T> {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<T | null>(null);

  const existing = selectedId ? items.find(i => i.id === selectedId) ?? null : null;
  const selected = draft ?? existing;
  const isDraft = !!draft;

  const select = useCallback((id: string | null) => { setDraft(null); setSelectedId(id); }, []);

  const startDraft = useCallback(() => {
    if (!newDraft) return;
    setSelectedId(null);
    setDraft(newDraft());
  }, [newDraft]);

  const patch = useCallback((p: Partial<T>) => {
    // Draft edits merge in memory (pure functional update); existing items patch through to the store.
    if (draft) setDraft(d => (d ? { ...d, ...p } : d));
    else if (selectedId) onUpdate(selectedId, p);
  }, [draft, selectedId, onUpdate]);

  const commit = useCallback(() => {
    if (!draft || !onCreate) return;
    const id = onCreate(draft);
    setDraft(null);
    setSelectedId(id);
  }, [draft, onCreate]);

  const close = useCallback(() => { setDraft(null); setSelectedId(null); }, []);

  return { selectedId, selected, isDraft, select, startDraft, patch, commit, close };
}
