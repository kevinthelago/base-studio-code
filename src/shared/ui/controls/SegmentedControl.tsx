import type { ReactNode } from "react";
import "./segmentedControl.css";

export interface SegOption {
  label: ReactNode;
  /** Whether this option is currently active. */
  on: boolean;
  onClick: () => void;
  /** On-state colour. Default "accent". */
  tone?: "accent" | "allow" | "ask" | "deny";
  /** Show a leading dot in the current colour. */
  dot?: boolean;
  title?: string;
}

export interface SegmentedControlProps {
  options: SegOption[];
  /** "padded" (default) = gapped pill buttons in a padded container; "joined" = a tight shared-border bar. */
  variant?: "padded" | "joined";
  /** Button height: "sm" (22px, default) or "md" (24px). */
  size?: "sm" | "md";
  /** Optional leading label (e.g. "scope"). */
  label?: ReactNode;
  className?: string;
}

/** SegmentedControl — the one mutually-exclusive / multi-toggle button group: the control-vocabulary
 *  primitive that absorbs `.scope` · `.seg` · `.tri` · `.pill-group` (#1874). Each option owns its
 *  on-state + click, so it serves single-select and multi-select alike; `tone` covers the
 *  allow/ask/deny tri-states. */
export function SegmentedControl({ options, variant = "padded", size = "sm", label, className }: SegmentedControlProps) {
  return (
    <div className={"seg-ctl" + (className ? ` ${className}` : "")}>
      {label != null && <span className="seg-ctl-label">{label}</span>}
      <div className={`seg-grp ${variant} size-${size}`}>
        {options.map((o, i) => (
          <button
            key={i}
            type="button"
            title={o.title}
            className={"seg-btn tone-" + (o.tone ?? "accent") + (o.on ? " on" : "")}
            onClick={o.onClick}
          >
            {o.dot && <span className="seg-dot" />}
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}
