import { useAppStore } from "@/store";
import { Card } from "@/shared/ui/data/Card";
import { Button } from "@/shared/ui/controls/Button";
import { Box } from "@/shared/ui/layout/Box";
import { SettingsPageHeader } from "./SettingsPageHeader";

const prose: React.CSSProperties = { fontFamily: "var(--sans)", fontSize: 12, lineHeight: 1.6, color: "var(--fg-muted)" };

export function SkillsPage() {
  const setWorkspace = useAppStore((s) => s.setWorkspace);
  return (
    <Box style={{ maxWidth: 820 }}>
      <SettingsPageHeader
        title="Skills"
        description="How reusable agent skills are stored, packaged, and injected into sessions."
        descMb={22}
      />

      <Card title="Skills library">
        <Box style={prose}>
          <p style={{ margin: "0 0 10px 0" }}>
            A <strong>skill</strong> is a reusable markdown context block (prompt + bundled tools +
            guardrails) injected into an agent session. The library is a global SQLite store at{" "}
            <code>~/.base-studio-code/skills.db</code> (the <code>bsc-skill</code> CLI / <code>skilldb</code>{" "}
            crate), shared by every session.
          </p>
          <p style={{ margin: "0 0 10px 0" }}>
            Each <strong>enabled</strong> skill in a session's scope is written to{" "}
            <code>.claude/skills/&lt;slug&gt;/SKILL.md</code> at launch, so the agent loads it like any
            Claude Code skill. Packaged built-ins ship as data under <code>src-tauri/data/skills/</code>{" "}
            and seed the store on first run.
          </p>
          <p style={{ margin: "0 0 14px 0" }}>
            Browse the library, edit skills, manage task-groups, and assign them per session on the
            Skills screen.
          </p>
          <Button onClick={() => setWorkspace("skills")}>Open Skills library →</Button>
        </Box>
      </Card>
    </Box>
  );
}
