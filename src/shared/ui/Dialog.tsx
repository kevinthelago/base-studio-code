import { useEffect } from "react";

interface DialogProps {
  title: string;
  children: React.ReactNode;
  actions: React.ReactNode;
  onDismiss: () => void;
  danger?: boolean;
}

export function Dialog({ title, children, actions, onDismiss, danger }: DialogProps) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onDismiss();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onDismiss]);

  return (
    <div
      style={{
        position: "fixed", inset: 0, zIndex: 9000,
        background: "oklch(0 0 0 / 0.55)",
        display: "flex", alignItems: "center", justifyContent: "center",
      }}
      onMouseDown={onDismiss}
    >
      <div
        className="card"
        style={{
          minWidth: 360, maxWidth: 500, padding: "22px 24px",
          boxShadow: "0 8px 32px oklch(0 0 0 / 0.5)",
          borderColor: danger ? "var(--danger)" : undefined,
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h3 style={{
          margin: "0 0 10px", fontFamily: "var(--mono)", fontSize: 14, fontWeight: 600,
          color: danger ? "var(--danger)" : "var(--fg)",
        }}>
          {title}
        </h3>
        <div style={{ color: "var(--fg-muted)", fontSize: 12, lineHeight: 1.6, marginBottom: 20 }}>
          {children}
        </div>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          {actions}
        </div>
      </div>
    </div>
  );
}
