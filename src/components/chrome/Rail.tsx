import { TerminalSquare, BookOpen, Zap, Server, GitFork, FolderKanban, ShieldCheck, Sparkles, Settings } from "lucide-react";
import type { LucideIcon } from "lucide-react";

export type Screen = "console" | "knowledge" | "automation" | "extensions" | "github" | "projects" | "skills" | "agents" | "settings";

const NAV: Array<{ key: Screen; Icon: LucideIcon; title: string }> = [
  { key: "console",    Icon: TerminalSquare, title: "Console"         },
  { key: "projects",   Icon: FolderKanban,   title: "Projects"        },
  { key: "github",     Icon: GitFork,        title: "GitHub"          },
  { key: "agents",     Icon: ShieldCheck,    title: "Permissions"     },
  { key: "extensions", Icon: Server,         title: "MCP"             },
  { key: "skills",     Icon: Sparkles,       title: "Skills"          },
  { key: "automation", Icon: Zap,            title: "Automations"     },
  { key: "knowledge",  Icon: BookOpen,       title: "Knowledge Store" },
  { key: "settings",   Icon: Settings,       title: "Settings"        },
];

interface RailProps {
  active: Screen;
  onNavigate: (screen: Screen) => void;
}

export function Rail({ active, onNavigate }: RailProps) {
  return (
    <div className="rail">
      <div className="logo">b.</div>
      {NAV.map(({ key, Icon, title }) => (
        <button
          key={key}
          className={key === active ? "active" : ""}
          title={title}
          onClick={() => onNavigate(key)}
        >
          <Icon size={18} />
        </button>
      ))}
    </div>
  );
}
