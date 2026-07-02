import { Row } from "@/shared/ui/layout/Row";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";

/** Lifecycle sub-group header within the Projects section (Active · Drafting · Shipped). */
export function GroupHeader({ label, count, dot }: { label: string; count: number; dot: string }) {
  return (
    <Row gap={8} style={{ margin: "0 0 7px", paddingLeft: 2 }}>
      <Box as="span" bg={dot} radius={99} style={{ width: 6, height: 6}} />
      <Text mono size={10} tone="dim" style={{ textTransform: "uppercase", letterSpacing: ".07em" }}>{label}</Text>
      <Box as="span" className="mono" pad={[0, 5]} bg="var(--bg-elev2)" border="soft" radius={8} style={{ fontSize: 9, color: "var(--fg-muted)"}}>{count}</Box>
    </Row>
  );
}
