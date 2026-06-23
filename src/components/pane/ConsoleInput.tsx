// Native console input (#1158) — our own prompt that stands in for Claude's built-in TUI input.
// A bottom bar (the status footer's slot, same dark profile) that the terminal sits ABOVE — so the
// terminal's scrollbar ends at the input's top edge rather than running behind it. The textarea
// wraps and grows with the text up to 5 lines, then scrolls. Submitting routes to the PTY (Claude's
// stdin): Enter sends, Shift+Enter inserts a newline, multi-line is sent as a bracketed paste so
// embedded newlines don't submit early; Escape sends ESC, and Ctrl+C on an empty input interrupts.

import { useEffect, useLayoutEffect, useRef, useState } from "react";

const LINE_PX = 18;   // textarea line box (fontSize 12 · line-height 18px)
const MAX_LINES = 5;  // grow up to 5 lines, then the textarea scrolls

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
  const taRef = useRef<HTMLTextAreaElement>(null);

  // Auto-size the textarea to its content, 1..MAX_LINES rows, then scroll.
  useLayoutEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "0px";
    const max = LINE_PX * MAX_LINES;
    ta.style.height = Math.min(ta.scrollHeight, max) + "px";
    ta.style.overflowY = ta.scrollHeight > max ? "auto" : "hidden";
  }, [value, active]);

  // Take focus when this becomes the active+focused pane's input.
  useEffect(() => {
    if (active && focused) taRef.current?.focus();
  }, [active, focused]);

  if (!active) return null;

  const submit = () => {
    const v = value;
    setValue("");
    if (!v) { onSend("\r"); return; }
    // Bracketed paste keeps multi-line content from submitting at the first newline; the trailing
    // CR then submits the whole message. Single-line goes as-is.
    onSend(v.includes("\n") ? "\x1b[200~" + v + "\x1b[201~\r" : v + "\r");
  };

  return (
    <div
      style={{
        flex: "0 0 auto", display: "flex", alignItems: "flex-end", gap: 7,
        padding: "5px 10px", background: "#0c0e11", borderTop: "1px solid #1a1e24",
      }}
      onClick={() => taRef.current?.focus()}
    >
      <span style={{ color: "#9aa6f0", fontFamily: "var(--mono)", fontSize: 12, lineHeight: `${LINE_PX}px`, flex: "0 0 auto" }}>›</span>
      <textarea
        ref={taRef}
        rows={1}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
          else if (e.key === "Escape") { e.preventDefault(); onSend("\x1b"); }
          else if (e.key === "c" && e.ctrlKey && value === "") { e.preventDefault(); onSend("\x03"); }
        }}
        placeholder="Message the agent…  ⏎ send · ⇧⏎ newline · Esc dismiss · Ctrl+C interrupt"
        spellCheck={false}
        autoComplete="off"
        style={{
          flex: 1, minWidth: 0, resize: "none", background: "transparent", border: "none", outline: "none",
          color: "#e7e9ed", fontFamily: "var(--mono)", fontSize: 12, lineHeight: `${LINE_PX}px`,
          // Right gutter so the textarea's scrollbar (≥5 lines) never overlaps the text.
          paddingRight: 8, margin: 0, height: LINE_PX,
        }}
      />
      <span
        onClick={submit}
        title="Send to the agent (Enter)"
        style={{ cursor: "pointer", flex: "0 0 auto", color: "#9aa6f0", fontFamily: "var(--mono)", fontSize: 10, lineHeight: `${LINE_PX}px` }}
      >send ⏎</span>
    </div>
  );
}
