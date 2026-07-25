// Dropdown (#2675) — the app-themed single-select control that replaces a native <select>. A native
// select's popup list is rendered by the OS (an unstyleable white system menu on Windows); this renders
// the trigger + a floating listbox from divs on base-studio-code tokens, so the whole surface is on-brand.
// Accessible: aria-haspopup=listbox / aria-expanded on the trigger, role=listbox/option with
// aria-activedescendant, full keyboard nav (↑/↓/Home/End/Enter/Esc), and outside-click + Escape + scroll
// dismiss. `field` (bordered, input-like) and `ghost` (borderless toolbar/title) variants; sm/md sizes.
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import "./dropdown.css";

export interface DropdownOption<T extends string = string> {
  value: T;
  label: ReactNode;
  /** Optional leading node (a color dot, glyph, avatar). */
  lead?: ReactNode;
  disabled?: boolean;
}

export interface DropdownProps<T extends string = string> {
  value: T;
  onChange: (value: T) => void;
  options: DropdownOption<T>[];
  /** Shown on the trigger when `value` matches no option. */
  placeholder?: ReactNode;
  /** `field` = bordered input-like control; `ghost` = borderless-until-hover (toolbars). Default `field`. */
  variant?: "field" | "ghost";
  /** Control height/scale. Default `md`. */
  size?: "sm" | "md";
  disabled?: boolean;
  "aria-label"?: string;
  className?: string;
  /** Menu min width in px; defaults to the trigger width so the menu is at least as wide as the trigger. */
  menuMinWidth?: number;
}

interface MenuPos { left: number; top: number; minWidth: number }

/** Scroll an element into view, tolerating jsdom (which doesn't implement scrollIntoView). */
function scrollIntoViewSafe(el: HTMLElement | null | undefined) {
  try { el?.scrollIntoView({ block: "nearest" }); } catch { /* jsdom / unsupported */ }
}

export function Dropdown<T extends string = string>({
  value, onChange, options, placeholder = "Select…",
  variant = "field", size = "md", disabled, className, menuMinWidth,
  "aria-label": ariaLabel,
}: DropdownProps<T>) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [pos, setPos] = useState<MenuPos>({ left: 0, top: 0, minWidth: 0 });
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const baseId = useId();
  const optId = (i: number) => `${baseId}-opt-${i}`;

  const selected = options.find((o) => o.value === value);
  const firstEnabled = (from: number, dir: 1 | -1): number => {
    const n = options.length;
    if (n === 0) return -1;
    let j = from;
    for (let k = 0; k < n; k++) {
      if (options[j] && !options[j].disabled) return j;
      j = (j + dir + n) % n;
    }
    return -1;
  };

  const close = useCallback((refocus = false) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  }, []);

  const openMenu = () => {
    if (disabled) return;
    const t = triggerRef.current;
    if (t) {
      const r = t.getBoundingClientRect();
      setPos({ left: r.left, top: r.bottom + 4, minWidth: menuMinWidth ?? r.width });
    }
    const cur = options.findIndex((o) => o.value === value);
    setActiveIndex(cur >= 0 && !options[cur]?.disabled ? cur : firstEnabled(0, 1));
    setOpen(true);
  };

  const select = (i: number) => {
    const o = options[i];
    if (!o || o.disabled) return;
    onChange(o.value);
    close(true);
  };

  // Refine placement after the menu mounts: flip above the trigger if it would overflow the viewport.
  useLayoutEffect(() => {
    if (!open) return;
    const t = triggerRef.current, m = menuRef.current;
    if (!t || !m) return;
    const r = t.getBoundingClientRect();
    const menuH = m.offsetHeight;
    const flip = menuH > 0 && r.bottom + 4 + menuH > window.innerHeight && r.top - menuH - 4 > 0;
    setPos({ left: r.left, top: flip ? r.top - menuH - 4 : r.bottom + 4, minWidth: menuMinWidth ?? r.width });
  }, [open, menuMinWidth]);

  // Move keyboard focus into the menu when it opens (drives the listbox key handling).
  useLayoutEffect(() => { if (open) menuRef.current?.focus(); }, [open]);

  // Keep the active option visible as the highlight moves.
  useEffect(() => {
    if (open) scrollIntoViewSafe(menuRef.current?.querySelector<HTMLElement>(`[data-idx="${activeIndex}"]`));
  }, [open, activeIndex]);

  // A pan/scroll or resize under an open menu invalidates its anchored position — dismiss (no refocus).
  useEffect(() => {
    if (!open) return;
    const dismiss = () => close(false);
    window.addEventListener("scroll", dismiss, true);
    window.addEventListener("resize", dismiss);
    return () => {
      window.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("resize", dismiss);
    };
  }, [open, close]);

  const step = (dir: 1 | -1) => setActiveIndex((i) => {
    const next = firstEnabled((i + dir + options.length) % options.length, dir);
    return next >= 0 ? next : i;
  });

  const onTriggerKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") { e.preventDefault(); openMenu(); }
  };

  const onMenuKey = (e: React.KeyboardEvent) => {
    switch (e.key) {
      case "ArrowDown": e.preventDefault(); step(1); break;
      case "ArrowUp": e.preventDefault(); step(-1); break;
      case "Home": e.preventDefault(); setActiveIndex(firstEnabled(0, 1)); break;
      case "End": e.preventDefault(); setActiveIndex(firstEnabled(options.length - 1, -1)); break;
      case "Enter":
      case " ": e.preventDefault(); if (activeIndex >= 0) select(activeIndex); break;
      case "Escape": e.preventDefault(); close(true); break;
      case "Tab": close(false); break;
    }
  };

  return (
    <div className={className ? `dd ${className}` : "dd"}>
      <button
        ref={triggerRef}
        type="button"
        className={`dd-trigger v-${variant} sz-${size}${open ? " open" : ""}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => (open ? close(false) : openMenu())}
        onKeyDown={onTriggerKey}
      >
        {selected?.lead != null && <span className="dd-lead">{selected.lead}</span>}
        <span className={selected ? "dd-value" : "dd-value dd-placeholder"}>{selected ? selected.label : placeholder}</span>
        <svg className="dd-caret" width={11} height={11} viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <>
          {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions -- click-away backdrop; keyboard dismiss is Escape via the menu's onMenuKey */}
          <div className="dd-backdrop" onMouseDown={() => close(false)} />
          <div
            ref={menuRef}
            className={`dd-menu sz-${size}`}
            role="listbox"
            tabIndex={-1}
            aria-activedescendant={activeIndex >= 0 ? optId(activeIndex) : undefined}
            onKeyDown={onMenuKey}
            style={{ position: "fixed", left: pos.left, top: pos.top, minWidth: pos.minWidth }}
          >
            {options.map((o, i) => (
              // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/interactive-supports-focus -- WAI-ARIA listbox option: roving focus via aria-activedescendant, keyboard handled at the listbox (onMenuKey)
              <div
                key={o.value}
                id={optId(i)}
                role="option"
                data-idx={i}
                aria-selected={o.value === value}
                aria-disabled={o.disabled || undefined}
                className={`dd-option${o.value === value ? " selected" : ""}${i === activeIndex ? " active" : ""}${o.disabled ? " disabled" : ""}`}
                onMouseEnter={() => { if (!o.disabled) setActiveIndex(i); }}
                onMouseDown={(e) => e.preventDefault()}  // keep focus on the menu through the click
                onClick={() => select(i)}
              >
                {o.lead != null && <span className="dd-lead">{o.lead}</span>}
                <span className="dd-option-label">{o.label}</span>
                {o.value === value && <span className="dd-check" aria-hidden="true">✓</span>}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
