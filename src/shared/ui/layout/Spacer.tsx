// Spacer — flexible or fixed empty space inside a Row/Stack (#2056). Replaces the ~40 hand-rolled
// `<div style={{ flex: 1 }} />` fillers that push trailing items to the far end of a row.
//
//   <Row>  <h3>Title</h3>  <Spacer/>  <Button/>  </Row>   → button pinned right
//   <Row>  a  <Spacer size="md"/>  b  </Row>              → a fixed 12px gap between a and b
//
// A fixed spacer (`size`) reserves a rigid box along the parent's main axis; the default
// (sizeless) spacer greedily absorbs the remaining space.

import type { CSSProperties } from "react";
import { space, type Space } from "./space";

export interface SpacerProps {
  /** A rigid spacer of this size (scale rung or raw px). Omit for a flexible (`flex:1`) spacer. */
  size?: Space;
  style?: CSSProperties;
}

export function Spacer({ size, style }: SpacerProps) {
  if (size != null) {
    const n = space(size);
    // `flex: 0 0 <n>` sizes it along the parent's main axis regardless of row/column direction.
    return <div aria-hidden style={{ flex: `0 0 ${n}px`, ...style }} />;
  }
  return <div aria-hidden style={{ flex: 1, ...style }} />;
}
