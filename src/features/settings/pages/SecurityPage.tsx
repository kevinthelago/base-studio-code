import { IssueSecurityCard } from "../cards/IssueSecurityCard";
import { AgentsCard } from "../cards/AgentsCard";
import { PermissionPostureCard } from "../cards/PermissionPostureCard";

export function SecurityPage() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18, maxWidth: 820 }}>
      {/* Header */}
      <h2 className="mono" style={{ fontSize: 18, margin: "0 0 4px", fontWeight: 600 }}>Security</h2>
      <p style={{ color: "var(--fg-muted)", margin: "0 0 4px", fontSize: 12 }}>
        Configure application security parameters, the default agent permission profile, and
        untrusted planning issue safeguards.
      </p>

      {/* Security Cards */}
      <AgentsCard />
      <PermissionPostureCard />
      <IssueSecurityCard />
    </div>
  );
}
