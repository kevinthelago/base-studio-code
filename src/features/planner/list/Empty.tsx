import { useAppStore } from "@/store";
import { Button } from "@/shared/ui/controls/Button";
import { EmptyState } from "@/shared/ui/feedback/EmptyState";
import { Chip } from "@/shared/ui/data/Chip";
import { SectionLabel } from "@/shared/ui/layout/SectionLabel";
import { Row } from "@/shared/ui/layout/Row";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";

/**
 * GitHub-not-connected state for the Projects page — the leaner of the two
 * "connect" screens. Projects is the planning + fleet surface, so the copy is
 * about turning a pitch into an executable plan and launching agents; the full
 * "what you get" showcase lives on the GitHub page (see github/Empty.tsx). The
 * two designs were swapped in #776 so each lives where its content applies.
 */
export function ProjectsEmpty() {
  const setWorkspace = useAppStore((s) => s.setWorkspace);
  const setSettingsSection = useAppStore((s) => s.setSettingsSection);

  return (
    <Box as="section" style={{
      flex: 1, display: "flex", alignItems: "center", justifyContent: "center",
      background: "var(--bg-canvas)", padding: "40px 32px", overflow: "auto",
    }}>
      <EmptyState
        variant="card"
        icon="🔒"
        title="Projects need GitHub"
        description="Planning with Claude turns a pitch into a complete, executable plan — features, milestones, granular issues, and a parallel agent fleet. Connect GitHub to publish that plan as a real Project board and run the fleet against your repos."
        actions={
          <Button
            variant="primary"
            // Land on the GitHub settings tab, not just the Settings screen.
            onClick={() => { setSettingsSection("github"); setWorkspace("settings"); }}
            style={{ height: 38, padding: "0 22px", fontSize: 13, fontWeight: 600, width: "100%", justifyContent: "center", gap: 10 }}
          >
            <Text mono size={15}>⎇</Text>
            Connect with GitHub
          </Button>
        }
        extra={
          <Box style={{
            marginTop: 20, padding: "12px 14px",
            borderRadius: 6, background: "var(--bg-elev)", border: "1px solid var(--border-soft)",
            textAlign: "left",
          }}>
            <SectionLabel style={{ marginBottom: 6 }}>Scopes requested</SectionLabel>
            <Row gap={6} align="stretch" wrap>
              {["repo", "project", "issues", "read:org"].map(s => (
                <Chip key={s}>{s}</Chip>
              ))}
            </Row>
          </Box>
        }
      />
    </Box>
  );
}
