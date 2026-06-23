// Native console input (#1149) — our own prompt that replaces Claude's built-in TUI input. When a
// Claude session is active we overlay this on the BOTTOM ~4 rows of the terminal (where Claude
// renders its own input box), hiding Claude's input from view and routing what the user types
// straight to the PTY (Claude's stdin). The terminal + PTY stay at full size, so there's no resize
// fight with the fit addon — we simply cover Claude's input region and type on its behalf.
//
// Enter submits (text + CR); Shift is reserved for a future multi-line mode. Escape sends ESC;
// Ctrl+C on an empty input sends an interrupt (SIGINT) so the user can still cancel a running turn.

import { useEffect, useRef, useState } from "react";
import { useAppStore } from "../../store";

interface ConsoleInputProps {
  /** Shown only when a Claude session is active in this pane. */
  active: boolean;
  /** This pane is the focused one — grab the caret so typing lands here, not in xterm. */
  focused?: boolean;
  /** Write bytes to the pane's PTY (and re-arm the run/idle status on submit). */
  onSend: (data: string) => void;
}

export function ConsoleInput({ active, focused, onSend }: ConsoleInputProps) {
  // Match the terminal's cell metrics so the overlay is exactly ~4 character rows tall —
  // "lower the console by 4 characters" — regardless of the user's terminal zoom.
  const fontSize = useAppStore((s) => s.terminalFontSize);
  const rowH = Math.round(fontSize * 1.4);
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
      // Cover the terminal's bottom rows. The terminal renders full-height behind us, so Claude's
      // own input (pinned to the bottom) sits underneath this opaque panel, out of view.
      style={{
        position: "absolute", left: 0, right: 0, bottom: 0, height: rowH * 4, zIndex: 5,
        background: "#181a1f", borderTop: "1px solid #2a2f37",
        display: "flex", flexDirection: "column", justifyContent: "center", gap: 5, padding: "0 10px",
      }}
      onClick={() => inputRef.current?.focus()}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ color: "#9aa6f0", fontFamily: "var(--mono)", fontSize: 13, flex: "0 0 auto" }}>›</span>
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
            else if (e.key === "Escape") { e.preventDefault(); onSend("\x1b"); }
            else if (e.key === "c" && e.ctrlKey && value === "") { e.preventDefault(); onSend("\x03"); }
          }}
          placeholder="Message the agent…"
          spellCheck={false}
          autoComplete="off"
          style={{
            flex: 1, minWidth: 0, background: "transparent", border: "none", outline: "none",
            color: "#eeeae4", fontFamily: "var(--mono)", fontSize: 13,
          }}
        />
        <span
          onClick={submit}
          title="Send to the agent (Enter)"
          style={{
            cursor: "pointer", flex: "0 0 auto", color: "#9aa6f0", fontFamily: "var(--mono)", fontSize: 10.5,
            padding: "2px 9px", border: "1px solid #2a2f37", borderRadius: 6,
          }}
        >send ⏎</span>
      </div>
      <div style={{ fontFamily: "var(--mono)", fontSize: 9, color: "#565c66", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
        native input · routed to the agent · Esc dismiss · Ctrl+C interrupt
      </div>
    </div>
  );
}
