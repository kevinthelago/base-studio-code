// ProjectCard (#3802) — the Projects page's card, modelled on the Skills library's `SkillCard`
// (`features/skills/SkillsViews.tsx`): a `<Card interactive onClick>` with a status-hued icon tile,
// title, chips (status + repos), description, an items/open + progress footer, the live fleet pill,
// and an "open →" affordance. It renders any of the four project sources (board / local-published /
// in-progress / bare draft) from one unified `ProjectItem`; the `status` drives the accent and the
// `source` drives the ⋯-menu (board: open-board/delete · draft: delete · local: none). A `variant`
// prop switches between the two-column grid CARD and the full-width LIST row (the density toggle).
import { useRef } from "react";
import { useClickOutside } from "@/shared/hooks/useClickOutside";
import { FolderGit2, PackageCheck, Hammer, PenLine, MoreHorizontal, ExternalLink, Trash2, type LucideIcon } from "lucide-react";
import { timeAgoMs } from "@/shared/lib/core/format";
import { Card } from "@/shared/ui/data/Card";
import { Chip } from "@/shared/ui/data/Chip";
import { FillBar } from "@/shared/ui/data/FillBar";
import { IconBox } from "@/shared/ui/data/IconBox";
import { Button } from "@/shared/ui/controls/Button";
import { Row } from "@/shared/ui/layout/Row";
import { Grid } from "@/shared/ui/layout/Grid";
import { Box } from "@/shared/ui/layout/Box";
import { Spacer } from "@/shared/ui/layout/Spacer";
import { Text } from "@/shared/ui/typography/Text";
import { STATUS_META, TYPE_META, type ProjectItem, type ProjectStatus } from "./projectsFilter";

const STATUS_ICON: Record<ProjectStatus, LucideIcon> = {
  active: FolderGit2, shipped: PackageCheck, "in-progress": Hammer, draft: PenLine,
};

export interface ProjectCardProps {
  item: ProjectItem;
  onOpen: (item: ProjectItem) => void;
  /** Open the GitHub board (board source only). */
  onBoard?: (item: ProjectItem) => void;
  /** Delete — routed by the composer (board ⇒ Keep-vs-Delete modal · draft ⇒ delete-draft confirm). */
  onDelete?: (item: ProjectItem) => void;
  menuOpenId: string | null;
  setMenuOpenId: (id: string | null) => void;
  /** "card" (two-column grid) or "row" (full-width list). Default "card". */
  variant?: "card" | "row";
}

/** Live "N agents running · M paused" pill (matched by repo). */
function FleetPill({ running, paused }: { running: number; paused: number }) {
  if (running === 0 && paused === 0) return null;
  return (
    <Box as="span" className="mono" pad={[2, 9]} bg="color-mix(in oklch, var(--success), transparent 88%)" radius={99} style={{
      display: "inline-flex", alignItems: "center", gap: 6, fontSize: 9.5, color: "var(--success)",
      border: "1px solid color-mix(in oklch, var(--success), transparent 70%)",
    }}>
      <Box as="span" bg="var(--success)" radius={99} style={{ width: 6, height: 6, animation: "pulse 1.4s ease-in-out infinite" }} />
      <Box as="span">{running} agent{running !== 1 ? "s" : ""} running</Box>
      {paused > 0 && <Text as="span" tone="dim">· {paused} paused</Text>}
    </Box>
  );
}

/** The status-hued icon tile. */
function StatusTile({ status, big }: { status: ProjectStatus; big?: boolean }) {
  const hue = STATUS_META[status].dot;
  const Icon = STATUS_ICON[status];
  const size = big ? 34 : 28;
  return (
    <IconBox
      size={size}
      radius={8}
      background={`color-mix(in oklch, ${hue}, transparent 88%)`}
      border={`1px solid color-mix(in oklch, ${hue}, transparent 70%)`}
      color={hue}
    >
      <Icon size={big ? 16 : 14} />
    </IconBox>
  );
}

/** The ⋯ menu — board (open-board / delete) or draft (delete). Nothing for local-published. */
function CardMenu({ item, onBoard, onDelete, menuOpenId, setMenuOpenId }: Pick<ProjectCardProps, "item" | "onBoard" | "onDelete" | "menuOpenId" | "setMenuOpenId">) {
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = item.id;
  const isOpen = menuOpenId === menuId;
  useClickOutside(menuRef, () => setMenuOpenId(null), isOpen);

  const isBoard = item.source === "board";
  const isDraft = item.source === "draft";
  if (!isBoard && !isDraft) return null;

  return (
    // eslint-disable-next-line no-restricted-syntax -- click-outside menu needs a real DOM ref (Box isn't forwardRef)
    <div ref={menuRef} style={{ position: "relative" }} onClick={(e) => e.stopPropagation()}>
      <Button
        variant="ghost"
        style={{ height: 24, width: 24, padding: 0, display: "flex", alignItems: "center", justifyContent: "center" }}
        onClick={() => setMenuOpenId(isOpen ? null : menuId)}
        title="More options"
      >
        <MoreHorizontal size={13} />
      </Button>
      {isOpen && (
        <Box className="menu" style={{ minWidth: 178 }}>
          {isBoard && (
            <>
              {/* eslint-disable-next-line no-restricted-syntax -- dropdown menu item (.menu-item), not a .btn-family button */}
              <button className="menu-item" onClick={() => { setMenuOpenId(null); onBoard?.(item); }}>
                <ExternalLink size={12} /> open board on GitHub
              </button>
              <Box style={{ borderTop: "1px solid var(--border-soft)", margin: "4px 0" }} />
              {/* eslint-disable-next-line no-restricted-syntax -- dropdown menu item (.menu-item), not a .btn-family button */}
              <button className="menu-item danger" onClick={() => { setMenuOpenId(null); onDelete?.(item); }}>
                <Trash2 size={12} /> delete project
              </button>
            </>
          )}
          {isDraft && (
            // eslint-disable-next-line no-restricted-syntax -- dropdown menu item (.menu-item), not a .btn-family button
            <button className="menu-item danger" onClick={() => { setMenuOpenId(null); onDelete?.(item); }}>
              <Trash2 size={12} /> delete draft
            </button>
          )}
        </Box>
      )}
    </div>
  );
}

/** Repo chips + the overflow (+N). */
function RepoChips({ repos, max }: { repos: string[]; max: number }) {
  if (repos.length === 0) return null;
  return (
    <>
      {repos.slice(0, max).map((r) => <Chip key={r} size="xs">{r}</Chip>)}
      {repos.length > max && <Chip size="xs">+{repos.length - max}</Chip>}
    </>
  );
}

export function ProjectCard({ item, onOpen, onBoard, onDelete, menuOpenId, setMenuOpenId, variant = "card" }: ProjectCardProps) {
  const meta = STATUS_META[item.status];
  const hasProgress = item.itemsTotal > 0;
  const menu = <CardMenu item={item} onBoard={onBoard} onDelete={onDelete} menuOpenId={menuOpenId} setMenuOpenId={setMenuOpenId} />;

  if (variant === "row") {
    return (
      <Box className="project-row" onClick={() => onOpen(item)} data-project-id={item.id}>
        <Grid cols="auto 1fr auto" gap={12} align="center">
          <StatusTile status={item.status} />
          <Box style={{ minWidth: 0 }}>
            <Row gap={8} align="center" wrap style={{ marginBottom: 3 }}>
              {item.number != null && <Text as="span" mono size={10} tone="dim">#{item.number}</Text>}
              <Text as="span" size={13} weight={600} style={{ fontFamily: "var(--sans)", color: "var(--fg)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.title}</Text>
              <Chip tone={meta.tone} size="xs">{meta.label}</Chip>
              <Chip color={TYPE_META[item.appType].color} size="xs">{TYPE_META[item.appType].label}</Chip>
              <RepoChips repos={item.repos} max={2} />
              {item.source === "local" && <Text as="span" mono size={10} tone="dim">{item.key}</Text>}
            </Row>
            {item.description && (
              <Text as="div" tone="muted" size={11.5} style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 620 }}>{item.description}</Text>
            )}
          </Box>
          <Row gap={12} align="center" style={{ flexShrink: 0 }}>
            {hasProgress && (
              <Row className="mono" gap={8} align="center" style={{ fontSize: 10.5, color: "var(--fg-muted)" }}>
                <Box as="span"><b style={{ color: "var(--fg)" }}>{item.itemsTotal}</b> items</Box>
                {item.open > 0 && <Box as="span"><b style={{ color: "var(--fg)" }}>{item.open}</b> open</Box>}
                <FillBar value={item.pct} height={4} color={item.pct >= 1 ? "var(--success)" : "var(--accent)"} style={{ width: 48 }} />
                <Text as="span" tone="dim">{Math.round(item.pct * 100)}%</Text>
              </Row>
            )}
            <FleetPill running={item.running} paused={item.paused} />
            <Text as="span" mono size={10} tone="dim" style={{ whiteSpace: "nowrap" }}>{timeAgoMs(item.updatedAt)}</Text>
            <Text as="span" className="project-open mono" size={10.5} style={{ whiteSpace: "nowrap", color: "var(--fg-dim)" }}>open →</Text>
            {menu}
          </Row>
        </Grid>
      </Box>
    );
  }

  return (
    <Card className="project-card" interactive onClick={() => onOpen(item)}>
      <Row align="start" gap={11}>
        <StatusTile status={item.status} big />
        <Box style={{ flex: 1, minWidth: 0 }}>
          <Row gap={8} align="center">
            {item.number != null && <Text as="span" mono size={10} tone="dim">#{item.number}</Text>}
            <Text as="span" size={13.5} weight={600} style={{ fontFamily: "var(--sans)", color: "var(--fg)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.title}</Text>
            <Spacer />
            {menu}
          </Row>
          <Text as="div" size={11.5} tone="muted" style={{ marginTop: 4, lineHeight: 1.45, overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>
            {item.description || "No description yet."}
          </Text>
        </Box>
      </Row>

      <Row gap={6} wrap align="center" style={{ marginTop: 11 }}>
        <Chip tone={meta.tone} size="sm">{meta.label}</Chip>
        <Chip color={TYPE_META[item.appType].color} size="sm">{TYPE_META[item.appType].label}</Chip>
        <RepoChips repos={item.repos} max={3} />
        <Spacer />
        {item.source === "local" && <Text as="span" mono size={10} tone="dim">{item.key}</Text>}
      </Row>

      <Row gap={10} align="center" style={{ marginTop: 11, paddingTop: 10, borderTop: "1px solid var(--border-soft)" }}>
        {hasProgress ? (
          <Row className="mono" gap={8} align="center" style={{ fontSize: 10.5, color: "var(--fg-muted)", minWidth: 0 }}>
            <Box as="span"><b style={{ color: "var(--fg)" }}>{item.itemsTotal}</b> items</Box>
            {item.open > 0 && <Box as="span"><b style={{ color: "var(--fg)" }}>{item.open}</b> open</Box>}
            <FillBar value={item.pct} height={4} color={item.pct >= 1 ? "var(--success)" : "var(--accent)"} style={{ width: 56 }} />
            <Text as="span" tone="dim">{Math.round(item.pct * 100)}%</Text>
          </Row>
        ) : (
          <Text as="span" mono size={10} tone="dim">updated {timeAgoMs(item.updatedAt)}</Text>
        )}
        <Spacer />
        <FleetPill running={item.running} paused={item.paused} />
        {hasProgress && <Text as="span" mono size={10} tone="dim">{timeAgoMs(item.updatedAt)}</Text>}
        <Text as="span" className="project-open mono" size={10.5} style={{ whiteSpace: "nowrap", color: "var(--fg-dim)" }}>open →</Text>
      </Row>
    </Card>
  );
}
