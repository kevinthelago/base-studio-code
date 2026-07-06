// TerminalSlot (#2378) — the placeholder a surface drops where an agent terminal should appear. It never
// mounts a <TerminalView> itself; it registers a claim with the app-level <TerminalHost>, which re-parents
// the pane's single terminal container into this slot's element. On unmount the host hands the terminal
// back to the previous claimant (or parks it), so moving between the console cell and the Glance dock never
// tears down the xterm/PTY. With no <TerminalHost> ancestor (a component rendered in isolation) the slot is
// an inert empty box — safe to render anywhere.
import { useEffect, useId, useRef } from "react";
import { useTerminalHost, type SlotTerminalProps } from "./TerminalHost";

export type TerminalSlotProps = { paneId: string } & SlotTerminalProps;

export function TerminalSlot({ paneId, ...props }: TerminalSlotProps) {
  const host = useTerminalHost();
  const elRef = useRef<HTMLDivElement>(null);
  const slotId = useId();
  // Latest props, read live by the host at portal-render time. Callback identity may churn each render, but
  // only mount-time cwd/initCmd and the reactive visible/focus (handled below) actually matter downstream.
  const propsRef = useRef<SlotTerminalProps>(props);
  propsRef.current = props;

  // Claim this paneId's terminal for as long as the slot is mounted. Re-registers if the paneId changes.
  useEffect(() => {
    const el = elRef.current;
    if (!host || !el) return;
    host.register(paneId, slotId, el, propsRef);
    return () => host.deregister(paneId, slotId);
  }, [host, paneId, slotId]);

  // The host reads props live, but must re-render to propagate a visibility/focus change to the shared
  // <TerminalView> (and to re-run the re-parent pass). Nudge it exactly on those two.
  useEffect(() => {
    host?.touch();
  }, [host, props.visible, props.focused]);

  return (
    // eslint-disable-next-line no-restricted-syntax -- imperative re-parent target: the host appendChilds the terminal container here
    <div ref={elRef} style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }} />
  );
}
