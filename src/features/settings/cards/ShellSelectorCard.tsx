import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { fireInvoke } from "@/shared/lib/core/safeInvoke";
import {
  loadShellKind,
  saveShellKind,
  coerceShellKind,
  SHELL_OPTIONS,
  type ShellKind,
} from "@/shared/lib/core/shellConfig";

export function ShellSelectorCard() {
  const [kind, setKind] = useState<ShellKind>(() => loadShellKind());

  useEffect(() => {
    let live = true;
    invoke<string>("get_preferred_shell")
      .then((v) => { if (live) setKind(coerceShellKind(v)); })
      .catch(() => { /* keep the local value */ });
    return () => { live = false; };
  }, []);

  function choose(next: ShellKind) {
    setKind(next);
    saveShellKind(next);
    fireInvoke("set_preferred_shell", { kind: next }, (e) => console.error("set_preferred_shell failed", e));
  }

  const active = SHELL_OPTIONS.find((o) => o.kind === kind) ?? SHELL_OPTIONS[0];

  return (
    <div className="card">
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 12 }}>
        <h3 style={{ margin: 0 }}>Console shell</h3>
        <span className="hint">the shell new console sessions launch under · applies to the next launch</span>
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {SHELL_OPTIONS.map((o) => {
          const on = o.kind === kind;
          return (
            <div
              key={o.kind}
              onClick={() => choose(o.kind)}
              style={{
                padding: "6px 12px", borderRadius: 6, cursor: "pointer",
                fontFamily: "var(--mono)", fontSize: 11,
                background: on ? "var(--accent)" : "var(--bg-elev)",
                color: on ? "#1a120a" : "var(--fg-muted)",
                border: "1px solid " + (on ? "transparent" : "var(--border-soft)"),
                fontWeight: on ? 600 : 400,
              }}
            >{o.label}</div>
          );
        })}
      </div>
      <div className="hint" style={{ marginTop: 10, lineHeight: 1.55 }}>
        {active.note}
        {!active.helpersFull && (
          <>
            {" "}
            <span style={{ color: "#e5c07b" }}>
              ⚠ The bsc-* helpers (checkpoint, notes, coordination) and startup-prompt
              injection are bash-only — sessions under this shell run without them.
            </span>
          </>
        )}
      </div>
    </div>
  );
}
