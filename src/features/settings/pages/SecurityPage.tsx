import { IssueSecurityCard } from "../cards/IssueSecurityCard";
import { AgentsCard } from "../cards/AgentsCard";
import { AgentRolesCard } from "../cards/AgentRolesCard";
import { PermissionPostureCard } from "../cards/PermissionPostureCard";
import { Stack } from "@/shared/ui/layout/Stack";

export function SecurityPage() {
  return (
    <Stack gap={18} style={{ maxWidth: 820 }}>
      {/* Header */}
      <h2 className="mono" style={{ fontSize: 18, margin: "0 0 4px", fontWeight: 600 }}>Security</h2>
      <p style={{ color: "var(--fg-muted)", margin: "0 0 4px", fontSize: 12 }}>
        Configure application security parameters, the default agent permission profile, and
        untrusted planning issue safeguards.
      </p>

      {/* Security Cards */}
      <AgentRolesCard />
      <AgentsCard />
      <PermissionPostureCard />
      <IssueSecurityCard />
    </Stack>
  );
}
