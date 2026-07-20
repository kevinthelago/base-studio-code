import { Button } from "@/shared/ui/controls/Button";

export function Toolbar({ render }: { render: (c: unknown) => unknown }) {
  return (
    <div className="toolbar">
      <span>{render(Button)}</span>
    </div>
  );
}
