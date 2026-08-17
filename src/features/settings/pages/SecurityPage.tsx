import { IssueSecurityCard } from "../cards/IssueSecurityCard";
import { AgentsCard } from "@/features/settings/cards/AgentsCard";
import { AgentRolesCard } from "@/features/settings/cards/AgentRolesCard";
import { PermissionPostureCard } from "../cards/PermissionPostureCard";
import { Stack } from "@/shared/ui/layout/Stack";
import { SettingsPageHeader } from "@/features/settings/pages/SettingsPageHeader";

export function SecurityPage() {
  return (
    <Stack gap={18} style={{ maxWidth: 820 }}>
      <SettingsPageHeader
        title="Security"
        description="Configure application security parameters, the default agent permission profile, and untrusted planning issue safeguards."
      />

      {/* Security Cards */}
      <AgentRolesCard />
      <AgentsCard />
      <PermissionPostureCard />
      <IssueSecurityCard />
    </Stack>
  );
}
