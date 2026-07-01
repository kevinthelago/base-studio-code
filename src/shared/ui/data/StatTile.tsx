import type { ReactNode, CSSProperties } from "react";
import { Card } from "./Card";
import "./statTile.css";

export interface StatTileProps {
  /** The uppercase label. */
  k: ReactNode;
  /** The big value. */
  v: ReactNode;
  /** Optional sub-text under the value. */
  sub?: ReactNode;
  /** Value colour tone. */
  tone?: "success" | "accent" | "danger";
  /** An explicit value style (e.g. a dynamic colour) — overrides `tone`. */
  vStyle?: CSSProperties;
  className?: string;
}

/** StatTile — the one metric tile: a card with an uppercase label (`k`), a big value (`v`), and an
 *  optional `sub`. Replaces the `.card` + `.k`/`.v`/`.sub` idiom whose styling was re-declared per
 *  feature (`.summary`, `.hist-summary`, …); the value tone maps to a colour. */
export function StatTile({ k, v, sub, tone, vStyle, className }: StatTileProps) {
  return (
    <Card className={"stat-tile" + (className ? ` ${className}` : "")}>
      <div className="k">{k}</div>
      <div className={"v" + (tone ? ` ${tone}` : "")} style={vStyle}>{v}</div>
      {sub != null && <div className="sub">{sub}</div>}
    </Card>
  );
}
