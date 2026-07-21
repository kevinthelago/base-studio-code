import { WORKSPACES, type Workspace } from "@/app/registry";
import { Box } from "@/shared/ui/layout/Box";
import { useAppStore } from "@/store";

// Re-export so existing `import type { Workspace } from ".../components/chrome/Rail"` keeps resolving
// (the type's home is now the screen registry — the single source of truth for screens).
export type { Workspace } from "@/app/registry";

interface RailProps {
  active: Workspace;
  onNavigate: (screen: Workspace) => void;
}

export function Rail({ active, onNavigate }: RailProps) {
  // The legacy Console page is hidden unless opted in (#2372): the graph (Glance) is the surface.
  const showConsolePage = useAppStore((s) => s.showConsolePage);
  const destinations = WORKSPACES.filter((w) => w.key !== "console" || showConsolePage);
  return (
    <Box className="rail">
      {destinations.map(({ key, Icon, label }) => (
        // eslint-disable-next-line no-restricted-syntax -- bespoke rail nav button (styled by the `.rail button` CSS selector, not the .btn kit)
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
