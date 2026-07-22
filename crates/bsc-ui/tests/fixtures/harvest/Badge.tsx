import { memo } from "react";

// #3571: a component WRAPPED in a higher-order call (memo/forwardRef/observer). The variable's value is a
// `call_expression`, not a bare arrow — the harvester used to skip it entirely.
export const Badge = memo(({ text }: { text: string }) => (
  <span className="badge">{text}</span>
));
