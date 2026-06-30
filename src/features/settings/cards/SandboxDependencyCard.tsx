import { Card } from "@/shared/ui/data/Card";
import { useAppStore } from "@/store";
import { useSandboxReadiness } from "@/shared/hooks/useSandboxReadiness";

/**
 * The OS-sandbox row of the dependency view (#1916). Shows the sandbox's status + the explicit, informed
 * install (with live progress), via the shared `useSandboxReadiness` hook. Inform-first: the install is
 * a button shown only after the gap is surfaced, never automatic. Rendered only under the deny-list
 * posture, where the OS sandbox is the layer that confines Bash (under the allow-list it isn't required).
 */
export function SandboxDependencyCard() {
  const bypassPermissions = useAppStore((s) => s.bypassPermissions);
  const { sandbox, installing, installLog, installMsg, install } = useSandboxReadiness();

  if (!bypassPermissions || !sandbox) return null;

  return (
    <Card title="OS sandbox (Bash isolation)">
      <div style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 12, lineHeight: 1.5 }}>
        <span
          style={{
            width: 8, height: 8, borderRadius: "50%", marginTop: 4, flexShrink: 0,
            background: sandbox.ready ? "var(--ok, #3fb950)" : "var(--warn, #d29922)",
          }}
          aria-hidden
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          <b>{sandbox.ready ? "Active" : "Not set up"}</b>{" "}
          <span style={{ color: "var(--fg-muted)" }}>— {sandbox.detail}</span>
          {!sandbox.ready && sandbox.autoInstallable && (
            <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 6 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <button
                  onClick={install}
                  disabled={installing}
                  style={{
                    background: "var(--accent)", border: "none", color: "var(--accent-text, #1a120a)",
                    cursor: installing ? "default" : "pointer", fontSize: 11, fontWeight: 600,
                    padding: "3px 10px", borderRadius: 4, opacity: installing ? 0.6 : 1,
                  }}
                >
                  {installing ? "Installing…" : sandbox.needsWsl ? "Install sandbox" : "Install bubblewrap"}
                </button>
                {installMsg && !installing && (
                  <span style={{ color: "var(--fg-muted)", fontSize: 11 }}>{installMsg}</span>
                )}
              </div>
              {installing && (
                <div aria-hidden style={{ height: 3, borderRadius: 2, background: "var(--bg-elev2)", overflow: "hidden" }}>
                  <div style={{ height: "100%", width: "30%", background: "var(--accent)", animation: "scan 1.1s linear infinite" }} />
                </div>
              )}
              {installLog.length > 0 && (
                <pre
                  className="mono"
                  style={{
                    margin: 0, maxHeight: 120, overflow: "auto", padding: "6px 8px", borderRadius: 4,
                    background: "var(--bg-canvas)", border: "1px solid var(--border-soft)",
                    fontSize: 10.5, lineHeight: 1.5, color: "var(--fg-muted)", whiteSpace: "pre-wrap",
                  }}
                >
                  {installLog.join("\n")}
                </pre>
              )}
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}
