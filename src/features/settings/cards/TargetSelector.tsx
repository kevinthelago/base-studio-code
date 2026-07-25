// The scope/target selector row for the Claude Config editor (#2128), extracted verbatim from
// ClaudeConfigCard.tsx. Presentational: renders the "global" + per-repo target chips.

import { Stack } from "@/shared/ui/layout/Stack";
import { Row } from "@/shared/ui/layout/Row";
import { Box } from "@/shared/ui/layout/Box";
import type { RepoTarget } from "./claudeConfig.helpers";

export function TargetSelector({
  allRepos, target, setTarget,
}: {
  allRepos: RepoTarget[];
  target: string;
  setTarget: (t: string) => void;
}) {
  return (
    <Stack gap={6}>
      <Box className="mono-label">
        target
      </Box>
      <Row gap={6} align="stretch" wrap>
        {(["global", ...allRepos.map((r) => r.local_path)] as string[]).map((t) => {
          const isGlobal = t === "global";
          const label = isGlobal ? "global (~/.claude/)" : (allRepos.find((r) => r.local_path === t)?.full_name ?? t);
          const on = target === t;
          return (
            <Box
              key={t}
              className="mono"
              onClick={() => setTarget(t)}
              pad={[5, 12]} bg={on ? "var(--accent)" : "var(--bg-elev)"} radius={6} style={{ cursor: "pointer",
                fontSize: 11,
                color: on ? "var(--on-accent)" : "var(--fg-muted)",
                border: "1px solid " + (on ? "transparent" : "var(--border-soft)"),
                fontWeight: on ? 600 : 400,
              }}
            >{label}</Box>
          );
        })}
      </Row>
      {allRepos.length === 0 && (
        <Box className="mono-caption">
          Resolve repositories on the Projects board to unlock per-repo targets.
        </Box>
      )}
    </Stack>
  );
}
