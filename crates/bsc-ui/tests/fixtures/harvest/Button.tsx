import { cx } from "clsx";

type ButtonProps = { label: string; tone?: string };

function toneClass(v: string) {
  return v === "primary" ? "btn btn-primary" : "btn";
}

const UNUSED_ELSEWHERE = "not referenced by Button";

export function Button({ label, tone }: ButtonProps) {
  return <button className={cx(toneClass(tone ?? "primary"))}>{label}</button>;
}
