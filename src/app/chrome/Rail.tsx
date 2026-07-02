import { WORKSPACES, type Workspace } from "@/app/registry";
import { Box } from "@/shared/ui/layout/Box";

// Re-export so existing `import type { Workspace } from ".../components/chrome/Rail"` keeps resolving
// (the type's home is now the screen registry — the single source of truth for screens).
export type { Workspace } from "@/app/registry";

interface RailProps {
  active: Workspace;
  onNavigate: (screen: Workspace) => void;
}

export function Rail({ active, onNavigate }: RailProps) {
  return (
    <Box className="rail">
      <Box className="logo">b.</Box>
      {WORKSPACES.map(({ key, Icon, label }) => (
        <button
          key={key}
          className={key === active ? "active" : ""}
          title={label}
          onClick={() => onNavigate(key)}
        >
          <Icon size={18} />
        </button>
      ))}
    </Box>
  );
}
