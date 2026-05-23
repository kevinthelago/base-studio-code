interface StatusBarProps {
  extra?: React.ReactNode;
}

export function StatusBar({ extra }: StatusBarProps) {
  return (
    <div className="statusbar">
      <div className="s">
        <i />
        claude · 14.2k ctx
      </div>
      <div className="s">
        <i />
        github · synced
      </div>
      <div className="spacer" />
      {extra}
      <div>v0.1.0 · rust 1.78</div>
    </div>
  );
}
