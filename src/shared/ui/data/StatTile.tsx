import type { ReactNode, CSSProperties } from "react";
import { Card } from "./Card";
import { Skeleton } from "@/shared/ui/feedback/Skeleton";
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
  /** Render the value (and sub) as shimmer placeholders while the metric's source loads (#2234). */
  loading?: boolean;
  className?: string;
}

/** StatTile — the one metric tile: a card with an uppercase label (`k`), a big value (`v`), and an
 *  optional `sub`. Replaces the `.card` + `.k`/`.v`/`.sub` idiom whose styling was re-declared per
 *  feature (`.summary`, `.hist-summary`, …); the value tone maps to a colour. */
export function StatTile({ k, v, sub, tone, vStyle, loading, className }: StatTileProps) {
  return (
    <Card className={"stat-tile" + (className ? ` ${className}` : "")}>
      <div className="k">{k}</div>
      {loading
        ? <div className="v"><Skeleton h={20} w={56} radius={5} style={{ margin: "3px 0" }} /></div>
        : <div className={"v" + (tone ? ` ${tone}` : "")} style={vStyle}>{v}</div>}
      {sub != null && (
        <div className="sub">{loading ? <Skeleton h={9} w={72} radius={4} /> : sub}</div>
      )}
    </Card>
  );
}
