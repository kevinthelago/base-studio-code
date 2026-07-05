// A minimal right-click context menu for the org canvas (#2385) — a manual-override affordance toward
// #2382 (UI as read-only). A fixed backdrop (any click/right-click closes) + a menu at the cursor with
// the delete action. Deliberately small: this is an interim escape hatch, not a full editing surface.
import { useEffect, useState } from "react";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";

export function OrgContextMenu({
  x, y, deleteLabel, onDelete, onClose,
}: {
  x: number;
  y: number;
  /** "Delete position" / "Delete relationship" — set by the caller from the target kind. */
  deleteLabel: string;
  onDelete: () => void;
  onClose: () => void;
}) {
  const [hover, setHover] = useState(false);

  // Escape closes the menu.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <>
      {/* Backdrop: any click (or another right-click) dismisses. */}
      <Box
        onClick={onClose}
        onContextMenu={(e) => { e.preventDefault(); onClose(); }}
        style={{ position: "fixed", inset: 0, zIndex: 60 }}
      />
      <Box
        role="menu"
        style={{
          position: "fixed", left: x, top: y, zIndex: 61, minWidth: 172,
          background: "var(--bg-elev)", border: "1px solid var(--border)", borderRadius: 8,
          boxShadow: "var(--shadow-md)", padding: 4,
        }}
      >
        <Box
          role="menuitem"
          onClick={() => { onDelete(); onClose(); }}
          onMouseEnter={() => setHover(true)}
          onMouseLeave={() => setHover(false)}
          style={{
            padding: "7px 10px", borderRadius: 6, cursor: "pointer",
            background: hover ? "color-mix(in oklch, var(--danger) 13%, transparent)" : "transparent",
          }}
        >
          <Text as="span" size={12} style={{ color: "var(--danger)" }}>{deleteLabel}</Text>
        </Box>
      </Box>
    </>
  );
}
