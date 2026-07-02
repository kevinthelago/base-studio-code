import { ConnectGithubCard } from "../cards/ConnectGithubCard";
import { RepoCredentialsCard } from "../cards/RepoCredentialsCard";
import { useAppStore } from "@/store";
import { Stack } from "@/shared/ui/layout/Stack";

export function GithubPage() {
  const { githubConnected, githubUser } = useAppStore();

  return (
    <Stack gap={18} style={{ maxWidth: 820 }}>
      {/* Header */}
      <h2 className="mono" style={{ fontSize: 18, margin: "0 0 4px", fontWeight: 600 }}>GitHub</h2>
      <p style={{ color: "var(--fg-muted)", margin: "0 0 4px", fontSize: 12 }}>
        Manage GitHub device authentication, OAuth profiles, and scoped repository credentials.
      </p>

      {/* GitHub Cards */}
      <ConnectGithubCard />
      {githubConnected && githubUser && (
        <RepoCredentialsCard />
      )}
    </Stack>
  );
}
