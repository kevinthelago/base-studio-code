import { Box } from "@/shared/ui/layout/Box";
import { Row } from "@/shared/ui/layout/Row";
import { Text } from "@/shared/ui/typography/Text";

export interface DiffLine {
  sign: " " | "+" | "-";
  text: string;
}

export interface DiffHunk {
  file: string;
  add: number;
  del: number;
  sample: DiffLine[];
}

interface ChangesViewProps {
  small?: boolean;
  hunks: DiffHunk[];
}

export function ChangesView({ small = false, hunks }: ChangesViewProps) {
  const totalAdd = hunks.reduce((s, h) => s + h.add, 0);
  const totalDel = hunks.reduce((s, h) => s + h.del, 0);

  return (
    <Box style={{
      flex: 1, minHeight: 0, overflow: "auto",
      padding: small ? "6px 8px" : "10px 12px",
    }}>
      <Row className="mono" align="baseline" gap={8} style={{
        marginBottom: 8,
        fontSize: 10, color: "var(--fg-dim)",
        textTransform: "uppercase", letterSpacing: ".06em",
      }}>
        <Text>{hunks.length} files changed</Text>
        <Text>·</Text>
        <Text tone="success">+{totalAdd}</Text>
        <Text tone="danger">−{totalDel}</Text>
        <Box style={{ flex: 1 }} />
        <Text tone="accent" style={{ textTransform: "none", letterSpacing: 0 }}>stash · commit</Text>
      </Row>
      {hunks.map((h, i) => (
        <Box key={i} border="soft" radius={5} style={{
          marginBottom: 8, overflow: "hidden",
        }}>
          <Row className="mono" align="baseline" gap={8} style={{
            padding: "5px 9px", background: "var(--bg-elev)",
            fontSize: small ? 10 : 11,
          }}>
            <Text style={{
              color: "var(--fg)", flex: 1,
              whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
            }}>{h.file}</Text>
            <Text tone="success" size={small ? 9.5 : 10}>+{h.add}</Text>
            <Text tone="danger" size={small ? 9.5 : 10}>−{h.del}</Text>
          </Row>
          <pre className="mono" style={{
            margin: 0, padding: "6px 0",
            fontSize: small ? 9.5 : 10.5,
            lineHeight: 1.5, background: "var(--bg-canvas)",
          }}>
            {h.sample.map((line, j) => (
              <Box key={j} pad={[0, 9]} bg={line.sign === "+" ? "color-mix(in oklch, var(--success), transparent 88%)"
                  : line.sign === "-" ? "color-mix(in oklch, var(--danger), transparent 88%)"
                  : "transparent"} style={{
                color: line.sign === "+" ? "var(--success)"
                  : line.sign === "-" ? "var(--danger)"
                  : "var(--fg-muted)",
              }}>
                <Text tone="dim" style={{ display: "inline-block", width: 10 }}>{line.sign}</Text>
                {line.text}
              </Box>
            ))}
          </pre>
        </Box>
      ))}
    </Box>
  );
}
