// ModalCard (#2420) — the titled head/body/foot modal card over ModalScrim, extracted from the four
// hand-rolled copies (blueprint import, MCP download, kit share, session skills). One canonical
// chrome: a bg-panel card (border · --r-lg · --shadow-xl · overflow hidden) with
//   head — optional IconBox glyph · mono title (+ dim sub) · optional headExtra rows · ✕ close
//   body — the scrollable content (padding 20 by default; override via bodyStyle for list layouts)
//   foot — an optional bordered action row.
// `<Dialog>` stays the lighter confirm/short-form card; ModalCard is for the richer titled modals.
//
//  - onClose wires BOTH the head ✕ and the scrim's Escape/overlay-click dismiss; omit it for a
//    non-dismissable modal. `busy` keeps the ✕ visible but disabled and suppresses scrim dismiss
//    (a destructive/long-running op in flight).
import type { CSSProperties, ReactNode } from "react";
import { ModalScrim } from "./ModalScrim";
import { IconBox } from "@/shared/ui/data/IconBox";
import { IconButton } from "@/shared/ui/controls/IconButton";
import { Row } from "@/shared/ui/layout/Row";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";

export interface ModalCardProps {
  title: ReactNode;
  /** Dim sub-line under the title. */
  sub?: ReactNode;
  /** Leading head glyph, rendered in a 30px IconBox (accent-tinted by default). */
  icon?: ReactNode;
  iconBackground?: string;
  iconColor?: string;
  /** Wires the head ✕ + Escape + scrim-click. Omit for a non-dismissable modal. */
  onClose?: () => void;
  /** Keep the ✕ but disable it and suppress scrim/Escape dismiss (an op in flight). */
  busy?: boolean;
  /** Card width (default 540). Always capped at maxWidth:100% of the padded scrim. */
  width?: number | string;
  /** Card max height (default "88vh"). */
  maxHeight?: string;
  /** Scrim card alignment — `start` top-aligns tall scrolling modals. */
  align?: "center" | "start";
  /** Backdrop blur (default true — the titled modals all used it). */
  blur?: boolean;
  /** Extra head rows under the title row (search/tabs/meta), inside the bordered head block. */
  headExtra?: ReactNode;
  /** Footer action row content; omitted → no foot. */
  foot?: ReactNode;
  /** Merged onto the body (padding/overflow overrides for list-style bodies). */
  bodyStyle?: CSSProperties;
  /** Merged onto the foot row (e.g. a darker footer bg). */
  footStyle?: CSSProperties;
  /** aria-label for the dialog card (defaults to the title when it is a string). */
  ariaLabel?: string;
  className?: string;
  children: ReactNode;
}

export function ModalCard({
  title, sub, icon, iconBackground, iconColor, onClose, busy = false,
  width = 540, maxHeight = "88vh", align, blur = true, headExtra, foot,
  bodyStyle, footStyle, ariaLabel, className, children,
}: ModalCardProps) {
  const dismiss = onClose && !busy ? onClose : undefined;
  return (
    <ModalScrim onDismiss={dismiss} align={align} blur={blur} style={{ padding: 30, ...(align === "start" ? { overflow: "auto" } : {}) }}>
      <Box
        className={className}
        role="dialog"
        aria-label={ariaLabel ?? (typeof title === "string" ? title : undefined)}
        style={{
          width, maxWidth: "100%", maxHeight,
          display: "flex", flexDirection: "column",
          background: "var(--bg-panel)", border: "1px solid var(--border)",
          borderRadius: "var(--r-lg)", boxShadow: "var(--shadow-xl)", overflow: "hidden",
        }}
      >
        <Box className="modal-head" style={{ padding: "16px 20px", borderBottom: "1px solid var(--border-soft)", flex: "none" }}>
          <Row gap={11}>
            {icon != null && (
              <IconBox size={30} radius={7} fontSize={13}
                background={iconBackground ?? "color-mix(in oklch, var(--accent), transparent 84%)"}
                color={iconColor ?? "var(--accent)"}>{icon}</IconBox>
            )}
            <Box style={{ minWidth: 0 }}>
              <Text as="h2" mono size="lg" weight={600} style={{ margin: 0 }}>{title}</Text>
              {sub != null && <Text as="div" size={10.5} tone="dim" style={{ marginTop: 1 }}>{sub}</Text>}
            </Box>
            {onClose && (
              <IconButton aria-label="close" style={{ marginLeft: "auto" }} onClick={onClose} disabled={busy} />
            )}
          </Row>
          {headExtra}
        </Box>
        <Box className="modal-body" style={{ padding: 20, overflowY: "auto", ...bodyStyle }}>{children}</Box>
        {foot != null && (
          <Row gap={9} className="modal-foot" style={{ padding: "14px 20px", borderTop: "1px solid var(--border-soft)", flex: "none", ...footStyle }}>
            {foot}
          </Row>
        )}
      </Box>
    </ModalScrim>
  );
}
