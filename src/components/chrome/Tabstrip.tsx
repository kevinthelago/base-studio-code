export interface Tab {
  name: string;
  layout: string;
  state?: "run" | "on" | "idle";
}

interface TabstripProps {
  tabs: Tab[];
  activeIdx?: number;
  onSelect?: (idx: number) => void;
  onClose?: (idx: number) => void;
  onAdd?: () => void;
}

export function Tabstrip({
  tabs,
  activeIdx = 0,
  onSelect,
  onClose,
  onAdd,
}: TabstripProps) {
  return (
    <div className="tabstrip">
      {tabs.map((t, i) => (
        <div
          key={i}
          className={"tab " + (i === activeIdx ? "active" : "")}
          onClick={() => onSelect?.(i)}
        >
          <span className={"dot " + (t.state ?? "")} />
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {t.name}
          </span>
          <span style={{ color: "var(--fg-dim)", marginLeft: 4, fontSize: 10 }}>
            {t.layout}
          </span>
          <span
            className="x"
            onClick={(e) => { e.stopPropagation(); onClose?.(i); }}
          >
            ×
          </span>
        </div>
      ))}
      <button className="tab-add" onClick={onAdd}>+</button>
      <div style={{ flex: 1 }} />
      <div style={{ alignSelf: "center", marginRight: 8, color: "var(--fg-dim)", fontSize: 10 }}>
        <span className="kbd">⌘1</span>{" "}
        <span className="kbd">⌘2</span>{" "}
        <span className="kbd">⌘T</span>
      </div>
    </div>
  );
}
