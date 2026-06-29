import { ConnectGithubCard } from "../cards/ConnectGithubCard";
import { RepoCredentialsCard } from "../cards/RepoCredentialsCard";
import { useAppStore } from "@/store";

export function GithubPage() {
  const { githubConnected, githubUser } = useAppStore();

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18, maxWidth: 820 }}>
      {/* Header */}
      <h2 style={{ fontFamily: "var(--mono)", fontSize: 18, margin: "0 0 4px", fontWeight: 600 }}>GitHub</h2>
      <p style={{ color: "var(--fg-muted)", margin: "0 0 4px", fontSize: 12 }}>
        Manage GitHub device authentication, OAuth profiles, and scoped repository credentials.
      </p>

      {/* GitHub Cards */}
      <ConnectGithubCard />
      {githubConnected && githubUser && (
        <RepoCredentialsCard />
      )}
    </div>
  );
}
