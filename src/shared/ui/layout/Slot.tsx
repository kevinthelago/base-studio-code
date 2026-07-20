// Slot (#3504) — a HOLE in a spec tree that the host fills with its own React.
//
// A node names a manifest primitive, which is exactly right for structure and exactly wrong for the
// leaves of a real app page: the Fleet page's layout is `Grid`/`Stack`/`Row`, but the things inside it
// are feature components (`WorkerBoard`, `MergeQueue`, …) that own hooks, queries and app state. They
// are app code, not kit — re-expressing them as primitives would be a lie, and giving up on the layout
// being data would defeat the point.
//
// So the spec says WHERE, and the host says WHAT: `{ type: "Slot", props: { name: "workerBoard" } }`
// resolves against the `slots` map passed to `KitRenderer`. This is the seam between the data tree and
// the code around it — the mechanism `SessionsBehaviorCard` anticipated ("a stateful bit the spec
// vocabulary can't express would be passed as a host slot") and did not need; a real page does.
//
// An UNFILLED slot renders a visible marker, never nothing. A blank where a panel should be is
// indistinguishable from "the layout meant to leave that empty" — the silent failure a data-driven UI
// must not have. The renderer substitutes a filled slot before this component is ever reached, so
// seeing this text means the name in the spec has no entry in the host's map (usually a typo, or a
// slot the host forgot to pass).

import { Text } from "@/shared/ui/typography/Text";

interface SlotProps {
  /** The key the host's `slots` map is expected to carry. */
  name?: string;
}

export function Slot({ name }: SlotProps) {
  return (
    <Text tone="danger" size="sm">
      {`[unfilled slot "${name ?? ""}" — the host supplied no content for this name]`}
    </Text>
  );
}
