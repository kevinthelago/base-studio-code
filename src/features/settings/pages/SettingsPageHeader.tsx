// SettingsPageHeader — the one settings page/section header (#2159). Collapses the byte-identical
// `<h2 className="mono">` title + muted `<p>` description that every Settings page hand-rolled, and
// the `Sub` (`<h3 className="mono">` group label) helper that General + Planner each redeclared, into
// two shared `<Text>`-backed primitives so the header style lives in exactly one place.

import type { ReactNode } from "react";
import { Text } from "@/shared/ui/typography/Text";

export interface SettingsPageHeaderProps {
  /** The page title (rendered as the mono h2). */
  title: string;
  /** Supporting copy under the title. */
  description: ReactNode;
  /**
   * Bottom margin under the description, in px. Defaults to 4 for the `Stack gap` pages (the Stack
   * owns the spacing to the first card); the `Box`-layout pages (Skills, Automations) pass 22.
   */
  descMb?: number;
}

/** The standard Settings page header: a mono h2 title over a muted description paragraph. */
export function SettingsPageHeader({ title, description, descMb = 4 }: SettingsPageHeaderProps) {
  return (
    <>
      <Text as="h2" mono size="xl" weight={600} style={{ margin: "0 0 4px" }}>{title}</Text>
      <Text as="p" tone="muted" size="md" style={{ margin: `0 0 ${descMb}px` }}>{description}</Text>
    </>
  );
}

/** A settings page sub-section header — the group label within a page (a scaled-down page h2). */
export function SettingsSubHeader({ children }: { children: ReactNode }) {
  return (
    <Text
      as="h3"
      mono
      size={12.5}
      weight={600}
      tone="dim"
      style={{ margin: "10px 0 -6px", textTransform: "uppercase", letterSpacing: ".07em" }}
    >
      {children}
    </Text>
  );
}
