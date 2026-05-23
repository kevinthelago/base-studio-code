interface TitlebarProps {
  workspace?: string;
  meta?: React.ReactNode;
}

export function Titlebar({
  workspace = "orchestrator · acme/payments",
  meta,
}: TitlebarProps) {
  return (
    <div className="titlebar">
      <div className="tl-lights">
        <i />
        <i />
        <i />
      </div>
      <div className="tl-title">base-studio-code — {workspace}</div>
      <div className="tl-meta">
        {meta ?? (
          <>
            <span>
              claude <b style={{ color: "var(--success)" }}>● connected</b>
            </span>
            <span>
              github <b>kevinthelago</b>
            </span>
          </>
        )}
      </div>
    </div>
  );
}
