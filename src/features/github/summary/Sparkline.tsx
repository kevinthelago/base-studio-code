// Tiny inline commit sparkline for the repo cards (#1644).

export function Sparkline({ data, w = 90, h = 22, color = "var(--accent)" }: { data: number[]; w?: number; h?: number; color?: string }) {
  if (data.length < 2) return null;
  const max = Math.max(...data, 1);
  const pts = data.map((v, i) => `${(i / (data.length - 1)) * w},${h - (v / max) * h}`).join(" ");
  return (
    <svg width={w} height={h} style={{ display: "block" }}>
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5"
        strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={w} cy={h - (data[data.length - 1] / max) * h} r="2" fill={color} />
    </svg>
  );
}
