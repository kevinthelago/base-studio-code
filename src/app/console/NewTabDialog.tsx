import { useState } from "react";
import { Dialog } from "@/shared/ui/overlay/Dialog";
import { Button } from "@/shared/ui/controls/Button";
import { Row } from "@/shared/ui/layout/Row";
import { Grid } from "@/shared/ui/layout/Grid";
import { Box } from "@/shared/ui/layout/Box";

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
        <Box className="field" role="group" aria-labelledby="new-tab-layout-label">
          {/* group caption, not a <label>: it names the swatch group below, not a single control */}
          <Box as="span" id="new-tab-layout-label" className="field-caption">Layout</Box>
          <Row gap={6} align="stretch" wrap>
            {LAYOUTS.map((l) => {
              const [c, r] = l.split("×").map(Number);
              const active = l === layout;
              return (
                // eslint-disable-next-line no-restricted-syntax -- bespoke layout-swatch button (grid-preview + active-state inline styling, not the .btn kit)
                <button
                  key={l}
                  className="mono"
                  type="button"
                  // eslint-disable-next-line jsx-a11y/no-autofocus -- intentional: focus the active layout swatch when the dialog opens
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
                  <Grid cols={`repeat(${c}, 10px)`} rows={`repeat(${r}, 7px)`} gap={2}>
                    {Array.from({ length: c * r }).map((_, i) => (
                      <Box key={i} bg={active ? "var(--accent)" : "var(--border)"} radius={1} />
                    ))}
                  </Grid>
                  {l}
                </button>
              );
            })}
          </Row>
        </Box>
      </form>
    </Dialog>
  );
}
