import { useState } from "react";
import { Dialog } from "@/shared/ui/overlay/Dialog";
import { Button } from "@/shared/ui/controls/Button";

/** The console grid layouts a new tab can open with. */
export const LAYOUTS: string[] = ["1×1", "2×1", "1×2", "2×2", "3×2", "3×3"];

interface NewTabDialogProps {
  onConfirm: (layout: string) => void;
  onDismiss: () => void;
}

/** The "new console workspace" dialog: pick a grid layout, create a tab. */
export function NewTabDialog({ onConfirm, onDismiss }: NewTabDialogProps) {
  const [layout, setLayout] = useState("2×2");

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    onConfirm(layout);
  }

  return (
    <Dialog title="New workspace" onDismiss={onDismiss} actions={
      <>
        <Button onClick={onDismiss}>cancel</Button>
        <Button variant="primary" onClick={handleSubmit}>create</Button>
      </>
    }>
      <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div className="field">
          <label>Layout</label>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {LAYOUTS.map((l) => {
              const [c, r] = l.split("×").map(Number);
              const active = l === layout;
              return (
                <button
                  key={l}
                  className="mono"
                  type="button"
                  autoFocus={l === layout}
                  onClick={() => setLayout(l)}
                  style={{
                    padding: "6px 10px", borderRadius: 5, cursor: "pointer",
                    fontSize: 11.5,
                    background: active ? "var(--bg-elev2)" : "var(--bg-elev)",
                    border: "1px solid " + (active ? "var(--accent)" : "var(--border-soft)"),
                    color: active ? "var(--accent)" : "var(--fg-muted)",
                    display: "flex", flexDirection: "column", alignItems: "center", gap: 4,
                  }}
                >
                  <div style={{
                    display: "grid",
                    gridTemplateColumns: `repeat(${c}, 10px)`,
                    gridTemplateRows: `repeat(${r}, 7px)`,
                    gap: 2,
                  }}>
                    {Array.from({ length: c * r }).map((_, i) => (
                      <div key={i} style={{
                        borderRadius: 1,
                        background: active ? "var(--accent)" : "var(--border)",
                      }} />
                    ))}
                  </div>
                  {l}
                </button>
              );
            })}
          </div>
        </div>
      </form>
    </Dialog>
  );
}
