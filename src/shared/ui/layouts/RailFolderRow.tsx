// RailFolderRow (#4128) — the ONE folder header both library rails render, extracted from the Design
// Studio's `RailTree` (#3632) so the Algorithms rail is the SAME row rather than a lookalike.
//
// A folder is the browsable structure of a library rail, so it reads as a full row — a folder glyph +
// disclosure caret + `weight: 500` label + a transitive count — not the dim uppercase micro-label it
// wore before #3632. The caret already carries open/closed, so one (closed-style) glyph covers both.
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";
import { RailRow } from "./RailRow";

/** The folder glyph. Monochrome `currentColor`, so it inherits the RailRow's `--fg-muted → --fg`
 *  hover/select brighten — the leaf-vs-container cue a bare label lacks. Sized a touch larger than the
 *  leaf dots so folders read as the tree's structure. */
export function FolderGlyph() {
  return (
    <svg
      viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ display: "block", opacity: 0.8 }}
    >
      <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" />
    </svg>
  );
}

export interface RailFolderRowProps {
  /** The folder's own segment (`controls`) — or the ungrouped bucket's label. */
  label: string;
  /** Records under this folder TRANSITIVELY. A collapsed folder still has to say how much is inside it. */
  count: number;
  open: boolean;
  onToggle: () => void;
  /** Whether this is the trailing bucket of records with no folder — changes only the tooltip. */
  ungrouped?: boolean;
  /** The full folder path, for the tooltip. Ignored when `ungrouped`. */
  path?: string;
  /** Extra class for selector/test hooks (`ds-compfolderhead` / `algo-folderhead`). */
  className?: string;
}

/** One folder header row in a library rail. The caller owns the expand state and renders the folder's
 *  children itself — this is the header only, so a rail keeps control of its own recursion. */
export function RailFolderRow({ label, count, open, onToggle, ungrouped, path, className }: RailFolderRowProps) {
  return (
    <RailRow
      className={className}
      caret={open}
      weight={500}
      onClick={onToggle}
      leading={<FolderGlyph />}
      trailing={<Text mono size="xxs" tone="dim">{count}</Text>}
      title={ungrouped ? "records with no folder" : `folder: ${path ?? label}`}
    >
      {label}
    </RailRow>
  );
}

/** The nesting indent one folder level applies to its children — shared so both rails step identically. */
export const FOLDER_INDENT_PX = 6;

/** The wrapper a folder's children render inside (subfolders then direct rows). */
export function RailFolderChildren({ children }: { children: React.ReactNode }) {
  return <Box style={{ paddingLeft: FOLDER_INDENT_PX }}>{children}</Box>;
}
