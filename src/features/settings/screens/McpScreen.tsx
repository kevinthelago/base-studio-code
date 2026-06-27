import { ClaudeConfigCard } from "../cards/ClaudeConfigCard";

export function McpScreen() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18, maxWidth: 820 }}>
      <ClaudeConfigCard />
    </div>
  );
}
