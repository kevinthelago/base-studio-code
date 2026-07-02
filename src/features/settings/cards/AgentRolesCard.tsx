// Settings → Security · Agent roles (#2094 Part B). A live, read-only roster of every session
// ROLE and the capability tier it launches under (#219 role gate). Every row is derived from
// `ROLE_DEFAULTS` at render time, so the card can NEVER drift from the enforcement core — add,
// remove, or re-tier a role in `role-capabilities.json` and this table follows automatically
// (e.g. dropping `conductor` simply stops rendering its row; nothing here is hardcoded).
//
// This is VIEW-only: it shows git / github / code / net access + write-scope + default profile per
// role. Editing capabilities is out of scope. Per-role agent IDENTITIES (start prompt / skills /
// model over a role) live in the Personas feature on the Planner workspace — a one-line pointer
// below sends the user there rather than duplicating that surface here.
import { useState } from "react";
import {
  ROLE_DEFAULTS,
  roleDeniedCommands,
  type SessionRole,
  type AccessTier,
  type RoleCapability,
} from "@/shared/lib/session/sessionRoles";
import { roleProfileId } from "@/shared/lib/session/roleProfile";
import { Card } from "@/shared/ui/data/Card";
import { Chip, type ChipTone } from "@/shared/ui/data/Chip";
import { Row } from "@/shared/ui/layout/Row";
import { Stack } from "@/shared/ui/layout/Stack";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";
import { Button } from "@/shared/ui/controls/Button";

/** Access-tier → chip tone: none = dim/neutral, read = info, write = accent (the capability legend). */
function tierTone(tier: AccessTier): ChipTone {
  return tier === "write" ? "accent" : tier === "read" ? "info" : "neutral";
}

/** The four capability axes, in the order the role gate reasons about them. */
const AXES: { key: keyof Pick<RoleCapability, "git" | "github" | "code" | "net">; label: string }[] = [
  { key: "git", label: "git" },
  { key: "github", label: "github" },
  { key: "code", label: "code" },
  { key: "net", label: "net" },
];

function RoleRow({ role }: { role: SessionRole }) {
  const cap = ROLE_DEFAULTS[role];
  const [open, setOpen] = useState(false);
  const denied = roleDeniedCommands(cap);
  const scope = cap.writeGlobs.length > 0 ? cap.writeGlobs.join("  ") : "—";

  return (
    <Box border="soft" radius="sm" pad={[9, 11]}>
      <Row justify="between" align="baseline" wrap gap={8}>
        <Text mono weight={600} size={12}>{role}</Text>
        <Text mono tone="muted" size={10} title="Default permission profile launched for this role">
          {roleProfileId(role)}
        </Text>
      </Row>

      {/* The four capability-tier chips — coloured by access level. */}
      <Row gap={6} wrap style={{ marginTop: 8 }}>
        {AXES.map(({ key, label }) => (
          <Chip key={key} tone={tierTone(cap[key])} size="sm">
            {label}: {cap[key]}
          </Chip>
        ))}
      </Row>

      {/* Write-scope: the globs this role may write (empty ⇒ "—", no code writes). */}
      <Row gap={6} align="baseline" wrap style={{ marginTop: 8 }}>
        <Text tone="dim" size={10}>write-scope</Text>
        <Text mono tone={cap.writeGlobs.length > 0 ? "muted" : "dim"} size={10.5}>{scope}</Text>
      </Row>

      {/* Optional: the mutating git/gh commands this role denies (deny > allow at launch). */}
      {denied.length > 0 && (
        <Box style={{ marginTop: 8 }}>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
          >
            {open ? "Hide" : "Show"} {denied.length} denied command{denied.length === 1 ? "" : "s"}
          </Button>
          {open && (
            <Row gap={6} wrap style={{ marginTop: 8 }}>
              {denied.map((cmd) => (
                <Chip key={cmd} tone="danger" size="xs">{cmd}</Chip>
              ))}
            </Row>
          )}
        </Box>
      )}
    </Box>
  );
}

/** The live role → capability roster on the Security page. Derived from `ROLE_DEFAULTS`, so it can't
 *  drift from the enforcement core; VIEW-only (capabilities are not editable here). */
export function AgentRolesCard() {
  // Live from the enforcement core — never a hardcoded role list.
  const roles = Object.keys(ROLE_DEFAULTS) as SessionRole[];

  return (
    <Card
      title="Agent roles"
      hint="live from the #219 role gate"
    >
      <Text as="p" tone="muted" size={12} style={{ margin: "0 0 14px", lineHeight: 1.6 }}>
        Every session launches under a <strong>role</strong> that bounds what it can do
        (least-privilege). These are the capability tiers each role is granted — <strong>git</strong>,{" "}
        <strong>github</strong>, <strong>code</strong>, and <strong>net</strong> access, its
        write-scope, and the default profile it runs under — read straight from the enforcement core,
        so this roster can never drift from what agents are actually allowed. Role <em>identities</em>{" "}
        (start prompt, skills, model) are defined as <strong>Personas</strong> on the Planner workspace.
      </Text>

      <Stack gap={8}>
        {roles.map((role) => (
          <RoleRow key={role} role={role} />
        ))}
      </Stack>
    </Card>
  );
}
