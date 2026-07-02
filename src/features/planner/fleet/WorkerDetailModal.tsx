// The modal shell used by the per-agent WorkerDetail page (#499) — a titled,
// dismissable card floated over a scrim with an optional footer action row.
import { ModalScrim } from "@/shared/ui/overlay/ModalScrim";
import { Row } from "@/shared/ui/layout/Row";
import { Spacer } from "@/shared/ui/layout/Spacer";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";
import { IconButton } from "@/shared/ui/controls/IconButton";

export function Modal({ title, children, onClose, footer }: {
  title: string; children: React.ReactNode; onClose: () => void; footer?: React.ReactNode;
}) {
  return (
    <ModalScrim onDismiss={onClose}>
      <Box bg="var(--bg-panel)" border radius="lg" style={{ width: 440, maxWidth: "90vw", boxShadow: "0 12px 40px rgba(0,0,0,0.5)" }}>
        <Row style={{ padding: "12px 16px", borderBottom: "1px solid var(--border-soft)" }}>
          <Text as="h3" style={{ margin: 0 }}>{title}</Text>
          <Spacer />
          <IconButton aria-label="close" onClick={onClose} />
        </Row>
        <Box pad={16}>{children}</Box>
        {footer && <Row justify="end" align="stretch" gap={8} style={{ padding: "12px 16px", borderTop: "1px solid var(--border-soft)" }}>{footer}</Row>}
      </Box>
    </ModalScrim>
  );
}
