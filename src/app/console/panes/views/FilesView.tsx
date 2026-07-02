import { Box } from "@/shared/ui/layout/Box";
import { Row } from "@/shared/ui/layout/Row";
import { Text } from "@/shared/ui/typography/Text";

export interface FileRow {
  name: string;
  path: string;
  depth?: number;
  dir?: boolean;
  open?: boolean;
  status?: "M" | "A" | "??" | "D";
}

interface FilesViewProps {
  small?: boolean;
  cwd?: string;
  tree: FileRow[];
  active?: string;
}

export function FilesView({ small = false, cwd, tree, active }: FilesViewProps) {
  return (
    <Box className="mono" style={{
      flex: 1, minHeight: 0, overflow: "auto",
      padding: small ? "6px 4px" : "8px 6px",
      fontSize: small ? 10 : 11, color: "var(--fg-muted)",
    }}>
      <Row gap={6} style={{
        padding: "2px 8px 6px", color: "var(--fg-dim)", fontSize: small ? 9.5 : 10,
      }}>
        <Text>{cwd}</Text>
        <Box as="span" style={{ flex: 1 }} />
        <Text tone="accent">± 4</Text>
      </Row>
      {tree.map((row, i) => (
        <Row key={i} gap={4} style={{
          padding: "2px 8px",
          paddingLeft: 8 + (row.depth ?? 0) * 12,
          background: row.path === active ? "var(--bg-elev)" : "transparent",
          borderRadius: 3,
          color: row.dir ? "var(--fg)" : "var(--fg-muted)",
          cursor: "pointer",
        }}>
          <Text tone="dim" style={{ width: 10, visibility: row.dir ? "visible" : "hidden" }}>
            {row.open ? "▾" : "▸"}
          </Text>
          <Text style={{
            color: row.dir ? "var(--accent)" : "var(--fg-muted)",
            opacity: row.dir ? 0.9 : 0.7,
          }}>
            {row.dir ? (row.open ? "⌹" : "⌷") : "·"}
          </Text>
          <Text style={{ flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {row.name}
          </Text>
          {row.status && (
            <Text size={small ? 9 : 9.5} style={{
              padding: "0 4px", borderRadius: 3,
              color: row.status === "M" ? "var(--accent)"
                : row.status === "A" ? "var(--success)"
                : row.status === "??" ? "var(--fg-dim)" : "var(--fg-muted)",
              background: "var(--bg-elev2)",
            }}>{row.status}</Text>
          )}
        </Row>
      ))}
    </Box>
  );
}
