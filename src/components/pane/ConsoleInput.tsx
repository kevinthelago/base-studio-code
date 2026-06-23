// Native console input (#1149) — our own prompt that replaces Claude's built-in TUI input. When a
// Claude session is active we overlay this on the BOTTOM ~4 rows of the terminal (where Claude
// renders its own input box), hiding Claude's input from view and routing what the user types
// straight to the PTY (Claude's stdin). The terminal + PTY stay at full size, so there's no resize
// fight with the fit addon — we simply cover Claude's input region and type on its behalf.
//
// Enter submits (text + CR); Shift is reserved for a future multi-line mode. Escape sends ESC;
// Ctrl+C on an empty input sends an interrupt (SIGINT) so the user can still cancel a running turn.

import { useEffect, useRef, useState } from "react";

interface ConsoleInputProps {
  /** Shown only when a Claude session is active in this pane. */
  active: boolean;
  /** This pane is the focused one — grab the caret so typing lands here, not in xterm. */
  focused?: boolean;
  /** Write bytes to the pane's PTY (and re-arm the run/idle status on submit). */
  onSend: (data: string) => void;
}

export function ConsoleInput({ active, focused, onSend }: ConsoleInputProps) {
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // Take focus when this becomes the active+focused pane's input.
  useEffect(() => {
    if (active && focused) inputRef.current?.focus();
  }, [active, focused]);

  if (!active) return null;

  const submit = () => {
    const v = value;
    setValue("");
    onSend(v + "\r");
  };

  return (
    <div
      // A SLIM single-row bar pinned to the pane's bottom — same dark background + slim profile as
      // the status footer it stands in for. It overlays the terminal's bottom row, so Claude's own
      // input (pinned there) sits underneath, out of view.
      style={{
        position: "absolute", left: 0, right: 0, bottom: 0, height: 26, zIndex: 5,
        background: "#0c0e11", borderTop: "1px solid #1a1e24",
        display: "flex", alignItems: "center", gap: 7, padding: "0 10px",
      }}
      onClick={() => inputRef.current?.focus()}
    >
      <span style={{ color: "#9aa6f0", fontFamily: "var(--mono)", fontSize: 12, flex: "0 0 auto" }}>›</span>
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
          else if (e.key === "Escape") { e.preventDefault(); onSend("\x1b"); }
          else if (e.key === "c" && e.ctrlKey && value === "") { e.preventDefault(); onSend("\x03"); }
        }}
        placeholder="Message the agent…  ⏎ send · Esc dismiss · Ctrl+C interrupt"
        spellCheck={false}
        autoComplete="off"
        style={{
          flex: 1, minWidth: 0, height: "100%", background: "transparent", border: "none", outline: "none",
          color: "#e7e9ed", fontFamily: "var(--mono)", fontSize: 12,
        }}
      />
      <span
        onClick={submit}
        title="Send to the agent (Enter)"
        style={{
          cursor: "pointer", flex: "0 0 auto", color: "#9aa6f0", fontFamily: "var(--mono)", fontSize: 10,
        }}
      >send ⏎</span>
    </div>
  );
}
