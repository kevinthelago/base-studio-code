import { ClaudeConfigCard } from "../cards/ClaudeConfigCard";
import { Stack } from "@/shared/ui/layout/Stack";

export function McpPage() {
  return (
    <Stack gap={18} style={{ maxWidth: 820 }}>
      <ClaudeConfigCard />
    </Stack>
  );
}
