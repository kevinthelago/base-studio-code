const TOOLS: [string, string, boolean][] = [
  ["read",    "Read files inside cwd",                  true  ],
  ["write",   "Write & patch files",                    true  ],
  ["bash",    "Run shell commands (sandboxed)",          true  ],
  ["git",     "Local git operations",                   true  ],
  ["gh",      "Authenticated GitHub API calls",         true  ],
  ["kb",      "Read/write Knowledge blocks",            true  ],
  ["http",    "Outbound HTTP (allowlisted hosts)",      false ],
  ["browser", "Headless browsing for docs",             false ],
];

export function IntegrationsSettings() {
  return (
    <div style={{ maxWidth: 820 }}>
      <h2 style={{ fontFamily: "var(--mono)", fontSize: 18, margin: "0 0 4px", fontWeight: 600 }}>Integrations</h2>
      <p style={{ color: "var(--fg-muted)", margin: "0 0 22px", fontSize: 12 }}>
        External services your agents can reach.
      </p>

      <div className="card">
        <div style={{ display: "flex", alignItems: "baseline", marginBottom: 12, gap: 10 }}>
          <h3 style={{ margin: 0 }}>Anthropic Claude</h3>
          <span className="tag green">● healthy</span>
          <span className="hint">last call 12s ago · 14.2k ctx</span>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 14 }}>
          <div className="field">
            <label>API key</label>
            <div style={{ display: "flex", gap: 8 }}>
              <input className="input" type="password" defaultValue="sk-ant-abcdef0123456789xxxxxxxxxxxxxxxxxxxxxxxxxxxx" />
              <button className="btn">show</button>
              <button className="btn">test</button>
            </div>
            <div className="hint">Stored in OS keyring · never written to disk in plaintext.</div>
          </div>
          <div className="field">
            <label>Default model</label>
            <select className="input" defaultValue="sonnet-4.5">
              <option>opus-4.5</option>
              <option value="sonnet-4.5">sonnet-4.5</option>
              <option>haiku-4.5</option>
            </select>
            <div className="hint">Per-pane override available from the hamburger menu.</div>
          </div>
          <div className="field">
            <label>Per-agent context cap</label>
            <input className="input" defaultValue="64000" />
          </div>
          <div className="field">
            <label>Monthly spend cap</label>
            <input className="input" defaultValue="$150" />
          </div>
          <div className="field" style={{ gridColumn: "1 / -1" }}>
            <label>Extended thinking</label>
            <div style={{ display: "flex", gap: 6 }}>
              {(["off", "auto", "always"] as const).map((v, i) => (
                <button key={v} className="btn" style={{
                  flex: 1, justifyContent: "center",
                  background: i === 1 ? "var(--bg-elev2)" : "var(--bg-elev)",
                  borderColor: i === 1 ? "var(--accent-dim)" : "var(--border-soft)",
                  color: i === 1 ? "var(--accent)" : "var(--fg)",
                }}>{v}</button>
              ))}
            </div>
            <div className="hint">Off for haiku regardless of this setting.</div>
          </div>
        </div>
      </div>

      <div style={{ height: 18 }} />

      <div className="card">
        <div style={{ display: "flex", alignItems: "baseline", marginBottom: 12, gap: 10 }}>
          <h3 style={{ margin: 0 }}>Tools available to agents</h3>
          <span className="hint">Tools the runtime exposes to Claude via the local registry.</span>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
          {TOOLS.map(([n, d, on]) => (
            <div key={n} style={{
              padding: "10px 12px", borderRadius: 6,
              background: "var(--bg-elev)", border: "1px solid var(--border-soft)",
              display: "flex", flexDirection: "column", gap: 4,
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{
                  fontFamily: "var(--mono)", fontSize: 11.5,
                  color: on ? "var(--accent)" : "var(--fg-muted)",
                }}>{n}</span>
                <span style={{ flex: 1 }} />
                <span style={{
                  width: 24, height: 14, borderRadius: 99,
                  background: on ? "var(--accent)" : "var(--bg-elev2)",
                  border: "1px solid " + (on ? "transparent" : "var(--border)"),
                  position: "relative",
                }}>
                  <span style={{
                    position: "absolute", top: 1,
                    ...(on ? { right: 1 } : { left: 1 }),
                    width: 10, height: 10, borderRadius: "50%",
                    background: on ? "#1a120a" : "var(--fg-dim)",
                  }} />
                </span>
              </div>
              <div className="hint">{d}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
