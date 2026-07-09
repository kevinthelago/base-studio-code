// Preview PAGE (#2668) — one of the three Design-Studio pages. A full-surface live preview of the
// selected kit / page, larger than the Design Studio inspector's mini-preview. Scaffolded here so the
// page shell + navigation land first (#2668 slice 1); the preview surface itself follows in a later slice.
import { Box } from "@/shared/ui/layout/Box";
import { EmptyState } from "@/shared/ui/feedback/EmptyState";

export function PreviewPage() {
  return (
    <Box className="ds-page">
      <EmptyState
        icon="◱"
        iconVariant="dashed"
        title="Preview"
        description={
          <>A full-surface live preview of the selected kit and pages will render here. For now, the
          per-component live preview lives in the <b style={{ color: "var(--fg)" }}>Design Studio</b>{" "}
          inspector.</>
        }
        style={{ height: "100%" }}
      />
    </Box>
  );
}
