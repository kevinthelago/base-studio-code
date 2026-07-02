import { useState, useRef } from "react";
import { Chip, tagTone } from "@/shared/ui/data/Chip";
import { useClickOutside } from "@/shared/hooks/useClickOutside";
import { ExternalLink, MoreHorizontal, Trash2 } from "lucide-react";
import { timeAgo } from "@/shared/lib/core/format";
import { Button } from "@/shared/ui/controls/Button";
import { Row } from "@/shared/ui/layout/Row";
import { Grid } from "@/shared/ui/layout/Grid";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";
import { STATUS_META, projStatus, projectProgress, type GhProject } from "./publishedModel";

/** Live "N agents running · M paused" pill for a project (matched by repo). */
function FleetPill({ running, paused }: { running: number; paused: number }) {
  if (running === 0 && paused === 0) return null;
  return (
    <Box as="span" className="mono" pad={[2, 9]} bg="color-mix(in oklch, var(--success), transparent 88%)" radius={99} style={{
      display: "inline-flex", alignItems: "center", gap: 6,
      fontSize: 9.5, color: "var(--success)",
      border: "1px solid color-mix(in oklch, var(--success), transparent 70%)",
    }}>
      <Box as="span" bg="var(--success)" radius={99} style={{ width: 6, height: 6, animation: "pulse 1.4s ease-in-out infinite" }} />
      <Box as="span">{running} agent{running !== 1 ? "s" : ""} running</Box>
      {paused > 0 && <Text as="span" tone="dim">· {paused} paused</Text>}
    </Box>
  );
}

/** Milestone-progress bar: fraction of the project's items that are closed. */
function ProgressBar({ pct }: { pct: number }) {
  return (
    <Box as="span" title={`${Math.round(pct * 100)}% of items closed`} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <Box as="span" bg="var(--bg-elev2)" radius={99} style={{ width: 56, height: 4, overflow: "hidden", display: "inline-block" }}>
        <Box as="span" bg={pct >= 1 ? "var(--success)" : "var(--accent)"} style={{ display: "block", height: "100%", width: `${pct * 100}%`}} />
      </Box>
      <Text as="span" mono size={9.5} tone="dim">{Math.round(pct * 100)}%</Text>
    </Box>
  );
}

interface ProjectRowProps {
  p: GhProject;
  running: number;
  paused: number;
  onPlan: (p: GhProject) => void;
  onBoard: (p: GhProject) => void;
  onDelete: (p: GhProject) => void;
  menuOpenId: string | null;
  setMenuOpenId: (id: string | null) => void;
}

export function ProjectRow({ p, running, paused, onPlan, onBoard, onDelete, menuOpenId, setMenuOpenId }: ProjectRowProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const isOpen  = menuOpenId === p.id;
  const [hover, setHover] = useState(false);
  const status = projStatus(p);
  const repos  = (p.repositories?.nodes ?? []).map(r => r.nameWithOwner.split("/")[1] ?? r.nameWithOwner);
  const { open, pct } = projectProgress(p);

  // Close on an outside mousedown (not click — so the menu doesn't unmount before an item's click fires).
  useClickOutside(menuRef, () => setMenuOpenId(null), isOpen);

  return (
    <Grid
      onClick={() => onPlan(p)}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      cols="1fr auto" gap={16} align="center"
      style={{
        padding: "13px 16px 13px 18px",
        cursor: "pointer", borderLeft: "2px solid " + (hover ? "var(--accent)" : "transparent"),
        background: hover ? "var(--bg-elev)" : "var(--bg-panel)",
      }}>
      <Box style={{ minWidth: 0 }}>
        <Row gap={9} wrap style={{ marginBottom: 5 }}>
          <Box as="span" bg={STATUS_META[status].dot} radius={99} style={{ width: 7, height: 7, flexShrink: 0 }} />
          <Text mono size={10} tone="dim">#{p.number}</Text>
          <Text as="h3" size={14} weight={600} style={{ margin: 0, fontFamily: "var(--sans)", color: "var(--fg)" }}>{p.title}</Text>
          <Chip tone={tagTone(STATUS_META[status].cls)} style={{ fontSize: 9.5 }}>{STATUS_META[status].label}</Chip>
          {repos.slice(0, 2).map(r => <Chip key={r} style={{ fontSize: 9.5 }}>{r}</Chip>)}
          {repos.length > 2 && <Chip style={{ fontSize: 9.5 }}>+{repos.length - 2}</Chip>}
        </Row>
        <Text as="div" tone="muted" size={12} style={{ lineHeight: 1.5, marginBottom: 9, maxWidth: 620 }}>
          {p.shortDescription ?? "No description."}
        </Text>
        <Row className="mono" gap={16} wrap style={{ fontSize: 10.5, color: "var(--fg-muted)" }}>
          {p.items.totalCount > 0 && <Box as="span"><b style={{ color: "var(--fg)" }}>{p.items.totalCount}</b> items</Box>}
          {open > 0 && <Box as="span"><b style={{ color: "var(--fg)" }}>{open}</b> open</Box>}
          {p.items.totalCount > 0 && <ProgressBar pct={pct} />}
          <Text tone="dim">updated {timeAgo(p.updatedAt)}</Text>
        </Row>
      </Box>

      <Row gap={10} style={{ flexShrink: 0 }}>
        <FleetPill running={running} paused={paused} />
        <Box as="span" className="mono" style={{
          fontSize: 10.5, whiteSpace: "nowrap",
          color: hover ? "var(--accent)" : "var(--fg-dim)", transition: "color .12s",
        }}>open planning →</Box>

        {/* ⋯ menu — stops row-click propagation */}
        {/* eslint-disable-next-line no-restricted-syntax -- click-outside menu needs a real DOM ref (Box isn't forwardRef) */}
        <div ref={menuRef} style={{ position: "relative" }} onClick={e => e.stopPropagation()}>
          <Button
            variant="ghost"
            style={{ height: 26, width: 26, padding: 0, display: "flex", alignItems: "center", justifyContent: "center" }}
            onClick={() => setMenuOpenId(isOpen ? null : p.id)}
            title="More options"
          >
            <MoreHorizontal size={14} />
          </Button>

          {isOpen && (
            <Box className="menu" style={{ minWidth: 178 }}>
              {/* eslint-disable-next-line no-restricted-syntax -- dropdown menu item (.menu-item), not a .btn-family button */}
              <button className="menu-item" onClick={() => { setMenuOpenId(null); onBoard(p); }}>
                <ExternalLink size={12} /> open board on GitHub
              </button>
              <Box style={{ borderTop: "1px solid var(--border-soft)", margin: "4px 0" }} />
              {/* eslint-disable-next-line no-restricted-syntax -- dropdown menu item (.menu-item), not a .btn-family button */}
              <button className="menu-item danger" onClick={() => { setMenuOpenId(null); onDelete(p); }}>
                <Trash2 size={12} /> delete project
              </button>
            </Box>
          )}
        </div>
      </Row>
    </Grid>
  );
}
