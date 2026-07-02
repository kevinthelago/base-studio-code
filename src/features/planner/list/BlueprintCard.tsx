import { useRef } from "react";
import { useClickOutside } from "@/shared/hooks/useClickOutside";
import { MoreHorizontal, Pencil, Check, Layers, Link2, Trash2 } from "lucide-react";
import { PlanGateRow } from "../pane/PlanStageBar";
import { IconBox } from "@/shared/ui/data/IconBox";
import { Button } from "@/shared/ui/controls/Button";
import { Row } from "@/shared/ui/layout/Row";
import { Box } from "@/shared/ui/layout/Box";
import { CAT_ICON, catHue, type BpItem } from "./blueprintLibrary.helpers";

/** A compact blueprint card for the right rail — hued icon tile + name + ⋯ menu, then a
 *  category / stages / visibility meta row and an optional gist link. */
export function BlueprintCard({ b, onUse, onOpen, onDelete, activeId, menuOpenId, setMenuOpenId }: {
  b: BpItem;
  onUse: (id: string) => void;
  onOpen: (b: BpItem) => void;
  onDelete: (b: BpItem) => void;
  activeId?: string;
  menuOpenId: string | null;
  setMenuOpenId: (id: string | null) => void;
}) {
  const isActive = b.id === activeId;
  const menuId = "bp:" + b.id;
  const isOpen = menuOpenId === menuId;
  const menuRef = useRef<HTMLDivElement>(null);
  useClickOutside(menuRef, () => setMenuOpenId(null), isOpen);

  const hue = catHue(b.category);
  const Icon = CAT_ICON[b.category] ?? Layers;

  return (
    <Box
      className="bp-rail-card"
      onClick={() => onUse(b.id)}
      title={isActive ? "Selected — new projects use this blueprint" : "Select this blueprint for new projects"}
      pad={[12, 13]} bg={isActive ? "var(--bg-elev2)" : "var(--bg-elev)"} radius={9} style={{
        border: "1px solid " + (isActive ? "var(--accent)" : "var(--border-soft)"), cursor: "pointer", position: "relative",
      }}>
      <Row className="bp-rail-card-head" gap={9}>
        <IconBox size={30} radius={8} background={`color-mix(in oklch, ${hue}, transparent 88%)`} border={`1px solid color-mix(in oklch, ${hue}, transparent 70%)`} color={hue}><Icon size={15} /></IconBox>
        <Row className="bp-rail-card-titlewrap" gap={7} style={{ flex: 1, minWidth: 0 }}>
          <Box as="span" className="bp-rail-card-title" style={{ fontFamily: "var(--sans)", fontSize: 13, fontWeight: 600, color: "var(--fg)", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{b.name}</Box>
          <Box as="span" className="bp-rail-card-cat mono" pad={[1, 6]} bg={`color-mix(in oklch, ${hue}, transparent 90%)`} radius={99} style={{
            flex: "0 0 auto", fontSize: 9, color: hue, border: `1px solid color-mix(in oklch, ${hue}, transparent 78%)`,
          }}>{b.category}</Box>
        </Row>
        {/* eslint-disable-next-line no-restricted-syntax -- click-outside menu needs a real DOM ref (Box isn't forwardRef) */}
        <div ref={menuRef} className="bp-rail-card-menu" style={{ position: "relative" }} onClick={e => e.stopPropagation()}>
          <Button
            variant="ghost"
            style={{ height: 22, width: 22, padding: 0, display: "flex", alignItems: "center", justifyContent: "center" }}
            onClick={() => setMenuOpenId(isOpen ? null : menuId)}
            title="More options"
          ><MoreHorizontal size={13} /></Button>
          {isOpen && (
            <Box className="menu" style={{ minWidth: 158 }}>
              {/* eslint-disable-next-line no-restricted-syntax -- dropdown menu item (.menu-item), not a .btn-family button */}
              <button className="menu-item" onClick={() => { setMenuOpenId(null); onUse(b.id); }}>
                <Check size={12} /> use for new projects
              </button>
              {/* eslint-disable-next-line no-restricted-syntax -- dropdown menu item (.menu-item), not a .btn-family button */}
              <button className="menu-item" onClick={() => { setMenuOpenId(null); onOpen(b); }}>
                <Pencil size={12} /> modify in planner
              </button>
              {!b.builtIn && (
                <>
                  <Box style={{ borderTop: "1px solid var(--border-soft)", margin: "4px 0" }} />
                  {/* eslint-disable-next-line no-restricted-syntax -- dropdown menu item (.menu-item), not a .btn-family button */}
                  <button className="menu-item danger" onClick={() => { setMenuOpenId(null); onDelete(b); }}>
                    <Trash2 size={12} /> delete blueprint
                  </button>
                </>
              )}
            </Box>
          )}
        </div>
      </Row>
      {/* Gated-stage progression (#blueprints): one segment per enabled, applicable section,
          colored by gate status — a preview of the lifecycle this blueprint walks through. */}
      <Box className="bp-rail-card-gates" style={{ marginTop: 9 }}>
        <PlanGateRow sections={b.sections} signals={{}} />
      </Box>
      {b.gistLabel && (
        <Row className="bp-rail-card-gist mono" gap={5} style={{ marginTop: 7, fontSize: 9, color: "var(--info)" }}>
          <Link2 size={10} />{b.gistLabel}
        </Row>
      )}
    </Box>
  );
}
