import { useState, useCallback } from "react";

/** useExpandable — Set-based expand/collapse (toggle-membership) state. Replaces the hand-rolled
 *  `useState<Set<string>>` + toggle that every expandable list (focused bodies, blueprint stages,
 *  scan entities, …) re-declares. `toggle(id)` flips membership; `isOpen(id)` reads it; `open` and
 *  `setOpen` are exposed for direct use. */
export function useExpandable(initial?: Iterable<string>) {
  const [open, setOpen] = useState<Set<string>>(() => new Set(initial));
  const toggle = useCallback((id: string) => {
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  }, []);
  const isOpen = useCallback((id: string) => open.has(id), [open]);
  return { open, isOpen, toggle, setOpen };
}
