// Service icon name → the glyph that draws it.
//
// Split from the workspace for two reasons. A file that exports both a component and a plain map
// loses fast refresh (`react-refresh/only-export-components`); and this cannot live in `lib/`, which
// is React-free by convention — a `LucideIcon` is a component, and importing lucide-react there
// would put React into the pure domain module.
//
// So the split is: `lib/credentials.ts` decides WHICH glyph name a service gets (pure, unit-tested),
// and this decides what that name draws as.
import { createElement } from "react";
import { KeyRound, Mail, MessageSquare, Cloud, Database, CreditCard, Server, Bot, AtSign } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Github } from "@/shared/ui/icons";
import { serviceIcon } from "@/features/credentials/lib/credentials";

/** Icon key (from `serviceIcon`) → glyph. Every value `SERVICE_ICONS` can produce needs an entry
 *  here, or the row silently draws the fallback key — `credentialsGlyphCoverage` in the test pins
 *  the two halves together so a new service cannot map to a glyph nothing renders. */
const GLYPHS: Record<string, LucideIcon> = {
  github: Github,
  mail: Mail,
  chat: MessageSquare,
  cloud: Cloud,
  database: Database,
  payments: CreditCard,
  server: Server,
  model: Bot,
  social: AtSign,
  key: KeyRound,
};

/** The glyph for a service, always resolvable. `serviceIcon` already falls an unmapped service back
 *  to `key`; this falls back again so a bad map entry costs an icon rather than the whole row. */
export function glyphFor(service: string | undefined): LucideIcon {
  return GLYPHS[serviceIcon(service)] ?? KeyRound;
}

/**
 * A service's icon.
 *
 * `createElement` rather than `const Glyph = glyphFor(…)` + `<Glyph />`: assigning a component to a
 * capitalized local inside a render body reads to `react-hooks/static-components` as creating a
 * component during render (which resets its state every pass). The glyph here is looked up from a
 * module-level map, never created — and calling `createElement` on it says so.
 */
export function ServiceGlyph({ service, size = 18 }: { service?: string; size?: number }) {
  return createElement(glyphFor(service), { size });
}
