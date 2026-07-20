import { Button } from "@/shared/ui/controls/Button";

export const Card = ({ title }: { title: string }) => (
  <div className="card">
    <h3>{title}</h3>
    <Button label="ok" />
  </div>
);
