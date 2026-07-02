// An explicit "not measured yet" card for the WorkerDetail page (#499) — the
// same honesty as Fleet's tokens card for analytics that aren't tracked per stream.
import { CardHead } from "@/shared/ui/charts";
import { Text } from "@/shared/ui/typography/Text";
import { Card } from "@/shared/ui/data/Card";

export function Placeholder({ title, hint, body }: { title: string; hint: string; body: string }) {
  return (
    <Card>
      <CardHead title={title} hint={hint} />
      <Text as="div" mono size={11} tone="dim" style={{ lineHeight: 1.6 }}>{body}</Text>
    </Card>
  );
}
