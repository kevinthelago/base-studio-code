// #3571: a plain JavaScript React component (.jsx). Before, only .ts/.tsx parsed, so a JS-React project
// harvested to zero. It has no @/ imports, so it stands alone and is buildable.
export function LegacyChip({ label }) {
  return <span className="chip">{label}</span>;
}
