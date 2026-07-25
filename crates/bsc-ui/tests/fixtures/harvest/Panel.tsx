import { Button } from "@/shared/ui/controls/Button";
import { useAppStore } from "@/store";

export function Panel({ title }: { title: string }) {
  const open = useAppStore((s) => s.panelOpen);
  return (
    <section className="panel">
      <h4>{title}</h4>
      {open ? <Button label="close" /> : null}
    </section>
  );
}
