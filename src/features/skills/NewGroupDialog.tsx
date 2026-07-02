// NewGroupDialog — the small modal for creating a named ⬡ task group (a reusable skill bundle).
import { useState } from "react";
import { Box } from "@/shared/ui/layout/Box";
import { Row } from "@/shared/ui/layout/Row";
import { Text } from "@/shared/ui/typography/Text";
import { Button } from "@/shared/ui/controls/Button";

export function NewGroupDialog({ onCreate, onClose }: { onCreate: (name: string) => void; onClose: () => void }) {
  const [name, setName] = useState("");
  return (
    <Box className="modal-scrim" onClick={onClose}>
      <Box onClick={(e) => e.stopPropagation()} pad={18} bg="var(--bg-panel)" border radius="lg" style={{ width: 360, boxShadow: "0 20px 60px rgba(0,0,0,.5)" }}>
        <Text as="div" size={14} weight={600} style={{ marginBottom: 4 }}>New task group</Text>
        <Text as="div" size={11.5} tone="muted" style={{ marginBottom: 12 }}>A named ⬡ bundle of skills you can toggle onto a session or fleet stream at once.</Text>
        {/* eslint-disable-next-line no-restricted-syntax -- bespoke autofocus dialog input with Enter-to-submit and a layout-critical marginBottom that TextField's .field wrapper would displace */}
        <input autoFocus className="input" placeholder="e.g. Release day" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && name.trim()) onCreate(name.trim()); }} style={{ width: "100%", marginBottom: 14 }} />
        <Row align="stretch" gap={8} justify="end">
          <Button onClick={onClose}>cancel</Button>
          <Button variant="primary" disabled={!name.trim()} onClick={() => onCreate(name.trim())}>create</Button>
        </Row>
      </Box>
    </Box>
  );
}
