import { SCREENS, type Screen } from "@/app/registry";

// Re-export so existing `import type { Screen } from ".../components/chrome/Rail"` keeps resolving
// (the type's home is now the screen registry — the single source of truth for screens).
export type { Screen } from "@/app/registry";

interface RailProps {
  active: Screen;
  onNavigate: (screen: Screen) => void;
}

export function Rail({ active, onNavigate }: RailProps) {
  return (
    <div className="rail">
      <div className="logo">b.</div>
      {SCREENS.map(({ key, Icon, label }) => (
        <button
          key={key}
          className={key === active ? "active" : ""}
          title={label}
          onClick={() => onNavigate(key)}
        >
          <Icon size={18} />
        </button>
      ))}
    </div>
  );
}
