export type Screen = "console" | "knowledge" | "automation" | "github" | "settings";

const NAV: Array<{ key: Screen; label: string; title: string }> = [
  { key: "console",    label: "⌘", title: "Console" },
  { key: "knowledge",  label: "K", title: "Knowledge Store" },
  { key: "automation", label: "A", title: "Automations" },
  { key: "github",     label: "G", title: "GitHub" },
  { key: "settings",   label: "⚙", title: "Settings" },
];

interface RailProps {
  active: Screen;
  onNavigate: (screen: Screen) => void;
}

export function Rail({ active, onNavigate }: RailProps) {
  return (
    <div className="rail">
      <div className="logo">b.</div>
      {NAV.map((n) => (
        <button
          key={n.key}
          className={n.key === active ? "active" : ""}
          title={n.title}
          onClick={() => onNavigate(n.key)}
        >
          {n.label}
        </button>
      ))}
      <div className="spacer" />
      <button title="Profile">@</button>
    </div>
  );
}
