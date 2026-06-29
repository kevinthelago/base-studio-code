import { ModalScrim } from "./ModalScrim";

interface DialogProps {
  title: string;
  children: React.ReactNode;
  actions: React.ReactNode;
  onDismiss: () => void;
  danger?: boolean;
}

export function Dialog({ title, children, actions, onDismiss, danger }: DialogProps) {
  return (
    <ModalScrim onDismiss={onDismiss}>
      <div
        className="card"
        style={{
          minWidth: 360, maxWidth: 500, padding: "22px 24px",
          boxShadow: "0 8px 32px oklch(0 0 0 / 0.5)",
          borderColor: danger ? "var(--danger)" : undefined,
        }}
      >
        <h3 className="mono" style={{
          margin: "0 0 10px", fontSize: 14, fontWeight: 600,
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
    </ModalScrim>
  );
}
