import type { ButtonHTMLAttributes } from "react";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Background style — the `.btn` family. `default` = the quiet bg-elev secondary · `primary` =
   *  the accent call-to-action · `ghost` = transparent. A DATA-DEFINED variant (#2569, authored via
   *  `bsc ui component btn define-variant`) is any other lowercase string: it rides the same
   *  class-name path (`.btn.<variant>`) that `applyVariantsToRoot`'s compiled CSS targets. */
  variant?: "default" | "primary" | "ghost" | (string & {});
  /** Danger color modifier (composes with `default`/`ghost`). */
  danger?: boolean;
  /** Hit size: `md` = 28px (default) · `sm` = 24px. */
  size?: "md" | "sm";
}

/**
 * The shared button primitive (#1889) — a thin wrapper over the `.btn` class system in
 * `tokens.css`, so it rides the exact styles the app already ships (no visual divergence) and
 * stays the one place button look is defined. Reach for this instead of a hand-rolled
 * `<button style={{…}}>` or a CSSProperties helper. For icon-only buttons use `IconButton`; for the
 * back-chevron use `BackButton`. All native `<button>` attributes (onClick, disabled, title, type,
 * style for one-off positional tweaks, …) pass through.
 */
export function Button({
  variant = "default", danger, size = "md", className, type = "button", ...rest
}: ButtonProps) {
  const cls = ["btn", variant !== "default" && variant, danger && "danger", size === "sm" && "sm", className]
    .filter(Boolean)
    .join(" ");
  return <button type={type} className={cls} {...rest} />;
}
