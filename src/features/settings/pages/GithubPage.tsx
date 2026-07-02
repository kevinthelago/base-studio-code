import { ConnectGithubCard } from "../cards/ConnectGithubCard";
import { RepoCredentialsCard } from "../cards/RepoCredentialsCard";
import { useAppStore } from "@/store";
import { Stack } from "@/shared/ui/layout/Stack";
import { SettingsPageHeader } from "./SettingsPageHeader";

export function GithubPage() {
  const { githubConnected, githubUser } = useAppStore();

  return (
    <Stack gap={18} style={{ maxWidth: 820 }}>
      <SettingsPageHeader
        title="GitHub"
        description="Manage GitHub device authentication, OAuth profiles, and scoped repository credentials."
      />

      {/* GitHub Cards */}
      <ConnectGithubCard />
      {githubConnected && githubUser && (
        <RepoCredentialsCard />
      )}
    </Stack>
  );
}
