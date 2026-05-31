// ProjectPane (#335) -- the planning page right visualizer pane, restructured into
// three collapsible sections: Project Files, Agent Permissions, and Repository.
// Ported from design/project-pane/project-pane.jsx (Files variety C + Permissions
// variety C + Repository variety A), skinned with the app design tokens
// (tokens.css), not the design coral/IBM Plex palette. Slice 1 renders the faithful
// visual with sample data; real-data wiring is a follow-up.
import { useState, type CSSProperties, type ReactNode } from "react";

/* -------------------------------- icons -------------------------------- */
const ICONS: Record<string, string> = {
  caret:    "M4 6l4 4 4-4",
  file:     "M4 2h5l3 3v9c0 .3-.2.5-.5.5h-7c-.3 0-.5-.2-.5-.5V2.5C4 2.2 4.2 2 4.5 2z M9 2v3h3",
  shield:   "M8 1.8l5 1.8v4c0 3.2-2.1 5.4-5 6.6-2.9-1.2-5-3.4-5-6.6v-4z",
  github:   "M8 1.6a6.4 6.4 0 00-2 12.5c.3 0 .4-.2.4-.4v-1.3c-1.8.4-2.2-.8-2.2-.8-.3-.7-.7-.9-.7-.9-.6-.4 0-.4 0-.4.6 0 1 .7 1 .7.6 1 1.5.7 1.9.6 0-.4.2-.7.4-.9-1.4-.2-2.9-.7-2.9-3.2 0-.7.3-1.3.7-1.7 0-.2-.3-.9.1-1.8 0 0 .5-.2 1.8.7a6 6 0 013.2 0c1.3-.9 1.8-.7 1.8-.7.4.9.1 1.6.1 1.8.4.4.7 1 .7 1.7 0 2.5-1.5 3-2.9 3.2.2.2.4.6.4 1.2v1.9c0 .2.1.4.4.4A6.4 6.4 0 008 1.6z",
  branch:   "M5 3.5v9 M11 3.5a1.6 1.6 0 100 3.2 1.6 1.6 0 000-3.2z M5 3.5a1.6 1.6 0 100 3.2 1.6 1.6 0 000-3.2z M5 12.5a1.6 1.6 0 100-3.2 1.6 1.6 0 000 3.2z M11 6.7c0 3-6 1.8-6 5.8",
  plus:     "M8 3.5v9 M3.5 8h9",
  star:     "M8 2l1.8 3.8 4.2.5-3.1 2.9.8 4.1L8 11.4 4.3 13.3l.8-4.1L2 6.3l4.2-.5z",
  pencil:   "M11.5 2.6l1.9 1.9-7.4 7.4-2.4.5.5-2.4z",
  refresh:  "M13 4.5a5.5 5.5 0 10.7 5 M13 2v3h-3",
  external: "M6 3.5H3.5v9h9V10 M9 3.5h3.5V7 M7 9l5.2-5.2",
  folder:   "M2 4.2c0-.6.5-1 1-1h3l1.3 1.4H13c.6 0 1 .4 1 1V12c0 .6-.5 1-1 1H3c-.6 0-1-.5-1-1z",
  terminal: "M3.5 4.5l3 3-3 3 M8.5 11h4",
  globe:    "M8 1.8a6.2 6.2 0 100 12.4A6.2 6.2 0 008 1.8z M2 8h12 M8 2c1.8 1.6 2.8 3.8 2.8 6S9.8 12.4 8 14 5.2 10.2 5.2 8 6.2 3.6 8 2z",
  package:  "M8 1.8L14 5v6l-6 3.2L2 11V5z M2 5l6 3 6-3 M8 8v6.2",
  eye:      "M1.5 8s2.4-4.2 6.5-4.2S14.5 8 14.5 8s-2.4 4.2-6.5 4.2S1.5 8 1.5 8z M8 9.8A1.8 1.8 0 108 6.2a1.8 1.8 0 000 3.6z",
};
const FILLED = new Set(["star"]);
function Icon({ name, size = 14, color = "currentColor", style }: { name: string; size?: number; color?: string; style?: CSSProperties }) {
  const filled = FILLED.has(name);
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden
      style={{ flex: "0 0 auto", display: "block", ...style }}
      fill={filled ? color : "none"} stroke={filled ? "none" : color}
      strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
      <path d={ICONS[name] ?? ""} />
    </svg>
  );
}

/* ------------------------------ primitives ----------------------------- */
function Seg<T extends string>({ options, value, onChange }: { options: { value: T; label: string }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div style={{ display: "flex", gap: 2, padding: 3, background: "var(--bg-canvas)", border: "1px solid var(--border-soft)", borderRadius: 8 }}>
      {options.map((o) => {
        const on = value === o.value;
        return (
          <button key={o.value} onClick={() => onChange(o.value)} style={{
            flex: 1, border: "none", cursor: "pointer", fontFamily: "var(--sans)", fontSize: 11.5, fontWeight: 500,
            padding: "6px 8px", borderRadius: 6, transition: ".14s", whiteSpace: "nowrap",
            background: on ? "var(--bg-elev2)" : "transparent", color: on ? "var(--fg)" : "var(--fg-muted)",
            boxShadow: on ? "0 1px 2px rgba(0,0,0,.25)" : "none",
          }}>{o.label}</button>
        );
      })}
    </div>
  );
}

type Tri = "allow" | "ask" | "deny";
const TRI: { value: Tri; label: string; color: string }[] = [
  { value: "allow", label: "Allow", color: "var(--success)" },
  { value: "ask",   label: "Ask",   color: "var(--accent)" },
  { value: "deny",  label: "Deny",  color: "var(--danger)" },
];
function TriState({ value, onChange }: { value: Tri; onChange: (v: Tri) => void }) {
  return (
    <div style={{ display: "flex", gap: 2, padding: 2, background: "var(--bg-canvas)", border: "1px solid var(--border-soft)", borderRadius: 7 }}>
      {TRI.map((t) => {
        const on = value === t.value;
        return (
          <button key={t.value} onClick={() => onChange(t.value)} style={{
            border: "none", cursor: "pointer", fontFamily: "var(--sans)", fontSize: 10.5, fontWeight: 600,
            padding: "4px 8px", borderRadius: 5, transition: ".14s", whiteSpace: "nowrap",
            background: on ? `color-mix(in oklch, ${t.color}, transparent 86%)` : "transparent",
            color: on ? t.color : "var(--fg-dim)",
          }}>{t.label}</button>
        );
      })}
    </div>
  );
}

function Group({ icon, title, count, actions, defaultOpen = true, children }: { icon: string; title: string; count?: number; actions?: ReactNode; defaultOpen?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div>
      <div onClick={() => setOpen((o) => !o)} style={{ display: "flex", alignItems: "center", gap: 9, padding: "12px 14px 10px", cursor: "pointer" }}>
        <Icon name="caret" size={13} color="var(--fg-dim)" style={{ transform: open ? "none" : "rotate(-90deg)", transition: ".15s" }} />
        <Icon name={icon} size={15} color="var(--accent)" />
        <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--fg)" }}>{title}</span>
        {count != null && <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-dim)", background: "var(--bg-elev2)", borderRadius: 20, padding: "1px 7px", fontVariantNumeric: "tabular-nums" }}>{count}</span>}
        <span style={{ flex: 1 }} />
        {actions && <div onClick={(e) => e.stopPropagation()} style={{ display: "flex", gap: 2 }}>{actions}</div>}
      </div>
      <div style={{ display: open ? "block" : "none", paddingBottom: 8 }}>{children}</div>
    </div>
  );
}

function IconBtn({ icon, title, onClick }: { icon: string; title: string; onClick?: () => void }) {
  return (
    <button title={title} onClick={onClick} style={{ width: 24, height: 24, display: "grid", placeItems: "center", border: "none", background: "transparent", color: "var(--fg-dim)", borderRadius: 5, cursor: "pointer" }}>
      <Icon name={icon} size={15} />
    </button>
  );
}
const DIVIDER: CSSProperties = { height: 1, background: "var(--border-soft)", margin: "0 14px" };

/* --------------------------------- data -------------------------------- */
interface MdFile { name: string; tok: string }
type Block = { t: "h" | "p" | "li"; s: string };
const MD_FILES: MdFile[] = [
  { name: "CLAUDE.md", tok: "1.2k" },
  { name: "PLAN.md", tok: "3.0k" },
  { name: "ARCHITECTURE.md", tok: "5.1k" },
  { name: "README.md", tok: "1.6k" },
  { name: "specs/auth-flow.md", tok: "1.5k" },
  { name: "notes/decisions.md", tok: "0.7k" },
];
const PREVIEW: Record<string, Block[]> = {
  "CLAUDE.md": [
    { t: "h", s: "Project conventions" },
    { t: "p", s: "TypeScript everywhere. Prefer composition over inheritance." },
    { t: "li", s: "Run `pnpm check` before every commit" },
    { t: "li", s: "No default exports in shared packages" },
  ],
  "PLAN.md": [
    { t: "h", s: "Auth refactor - current milestone" },
    { t: "li", s: "Phase 1 -- magic-link issuance + verify" },
    { t: "li", s: "Phase 2 -- OAuth fallback (`github`, `google`)" },
    { t: "li", s: "Phase 3 -- session migration and cutover" },
  ],
};

const CAPS: { k: string; label: string; icon: string }[] = [
  { k: "read", label: "Read files", icon: "eye" },
  { k: "edit", label: "Edit files", icon: "pencil" },
  { k: "make", label: "Create and delete", icon: "file" },
  { k: "cmd",  label: "Run commands", icon: "terminal" },
  { k: "net",  label: "Network access", icon: "globe" },
  { k: "git",  label: "Commit and push", icon: "branch" },
  { k: "pkg",  label: "Install packages", icon: "package" },
];
type PermState = Record<string, Tri>;
const PRESETS: Record<string, PermState> = {
  plan:     { read: "allow", edit: "deny",  make: "deny",  cmd: "deny",  net: "deny", git: "deny",  pkg: "deny" },
  balanced: { read: "allow", edit: "ask",   make: "ask",   cmd: "ask",   net: "deny", git: "ask",   pkg: "deny" },
  trusted:  { read: "allow", edit: "allow", make: "allow", cmd: "allow", net: "ask",  git: "allow", pkg: "ask" },
};

interface TreeNode { type: "dir" | "file"; name: string; git?: string; children?: TreeNode[] }
const REPO_TREE: TreeNode[] = [
  { type: "dir", name: "src", children: [
    { type: "dir", name: "auth", children: [
      { type: "file", name: "session.ts", git: "M" },
      { type: "file", name: "oauth.ts", git: "A" },
      { type: "file", name: "magic-link.ts" },
    ] },
    { type: "dir", name: "components", children: [
      { type: "file", name: "ProjectPane.tsx", git: "M" },
      { type: "file", name: "FileTree.tsx" },
    ] },
    { type: "file", name: "index.ts" },
  ] },
  { type: "dir", name: "docs", children: [
    { type: "file", name: "PLAN.md" },
    { type: "file", name: "ARCHITECTURE.md" },
  ] },
  { type: "file", name: "package.json", git: "M" },
  { type: "file", name: "README.md" },
];
const EXT_COLOR: Record<string, string> = { ts: "var(--info)", tsx: "var(--info)", js: "var(--accent)", json: "var(--accent)", md: "var(--accent)", css: "var(--info)" };
const extOf = (n: string) => n.slice(n.lastIndexOf(".") + 1);

/* ------------------------------ 1. Files ------------------------------- */
function FileName({ name }: { name: string }) {
  const i = name.lastIndexOf("/");
  const dir = i >= 0 ? name.slice(0, i + 1) : "";
  const base = i >= 0 ? name.slice(i + 1) : name;
  return <span style={{ fontSize: 13, color: "var(--fg)", fontWeight: 500 }}><span style={{ color: "var(--fg-dim)", fontWeight: 400 }}>{dir}</span>{base}</span>;
}
function renderInline(s: string) {
  const html = s.replace(/`([^`]+)`/g, `<code style="font-family:var(--mono);font-size:10.5px;background:var(--bg-canvas);padding:1px 4px;border-radius:3px;color:var(--fg)">$1</code>`);
  return <span dangerouslySetInnerHTML={{ __html: html }} />;
}
function SubHead({ label, n }: { label: string; n: number }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 7, padding: "8px 14px 5px" }}>
      <span style={{ fontFamily: "var(--mono)", fontSize: 10, fontWeight: 500, letterSpacing: ".13em", textTransform: "uppercase", color: "var(--fg-dim)" }}>{label}</span>
      <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)" }}>{n}</span>
    </div>
  );
}
function FilesSection() {
  const [open, setOpen] = useState<string | null>("CLAUDE.md");
  const pinned = MD_FILES.slice(0, 3);
  const library = MD_FILES.slice(3);
  const FileRow = (f: MdFile, pin: boolean) => {
    const isOpen = open === f.name;
    return (
      <div key={f.name}>
        <div onClick={() => setOpen(isOpen ? null : f.name)} style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 14px", cursor: "pointer", background: isOpen ? "var(--bg-elev)" : undefined }}>
          <Icon name="caret" size={13} color="var(--fg-dim)" style={{ transform: isOpen ? "none" : "rotate(-90deg)", transition: ".15s" }} />
          <span style={{ fontFamily: "var(--mono)", fontSize: 9, fontWeight: 600, letterSpacing: ".04em", width: 26, height: 18, flex: "0 0 auto", display: "grid", placeItems: "center", borderRadius: 4, color: "var(--accent)", background: "color-mix(in oklch, var(--accent), transparent 86%)", border: "1px solid color-mix(in oklch, var(--accent), transparent 70%)" }}>MD</span>
          <FileName name={f.name} />
          <span style={{ flex: 1 }} />
          {pin && <Icon name="star" size={12} color="var(--accent)" />}
          <span style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--fg-dim)", fontVariantNumeric: "tabular-nums" }}>{f.tok}</span>
        </div>
        {isOpen && PREVIEW[f.name] && (
          <div style={{ margin: "2px 14px 10px 40px", padding: "12px 14px", background: "var(--bg-canvas)", border: "1px solid var(--border-soft)", borderRadius: 8 }}>
            {PREVIEW[f.name].map((b, i) => b.t === "h"
              ? <div key={i} style={{ fontSize: 12.5, fontWeight: 700, color: "var(--fg)", marginBottom: 6 }}>{b.s}</div>
              : b.t === "p"
              ? <div key={i} style={{ fontSize: 11.5, color: "var(--fg-muted)", lineHeight: 1.5, marginBottom: 7 }}>{renderInline(b.s)}</div>
              : <div key={i} style={{ display: "flex", gap: 8, fontSize: 11.5, color: "var(--fg-muted)", lineHeight: 1.5, marginBottom: 4 }}>
                  <span style={{ color: "var(--accent)" }}>-</span>{renderInline(b.s)}
                </div>)}
            <button style={{ marginTop: 8, padding: "4px 9px", fontSize: 11, display: "inline-flex", alignItems: "center", gap: 6, background: "transparent", color: "var(--fg-muted)", border: "1px solid var(--border)", borderRadius: 5, cursor: "pointer", fontFamily: "var(--sans)" }}>
              <Icon name="pencil" size={11} />Edit
            </button>
          </div>
        )}
      </div>
    );
  };
  return (
    <Group icon="file" title="Project Files" count={MD_FILES.length} actions={<IconBtn icon="plus" title="New file" />}>
      <SubHead label="Pinned to context" n={pinned.length} />
      {pinned.map((f) => FileRow(f, true))}
      <div style={{ ...DIVIDER, margin: "6px 14px" }} />
      <SubHead label="Library" n={library.length} />
      {library.map((f) => FileRow(f, false))}
    </Group>
  );
}

/* ---------------------------- 2. Permissions --------------------------- */
function PermissionsSection() {
  const [preset, setPreset] = useState("balanced");
  const [state, setState] = useState<PermState>(PRESETS.balanced);
  const apply = (p: string) => { setPreset(p); if (PRESETS[p]) setState(PRESETS[p]); };
  const set = (k: string, v: Tri) => { setState((s) => ({ ...s, [k]: v })); setPreset("custom"); };
  return (
    <Group icon="shield" title="Agent Permissions">
      <div style={{ padding: "2px 14px 10px" }}>
        <Seg value={preset}
          options={[{ value: "plan", label: "Plan" }, { value: "balanced", label: "Balanced" }, { value: "trusted", label: "Trusted" }, { value: "custom", label: "Custom" }]}
          onChange={(v) => v !== "custom" && apply(v)} />
      </div>
      {CAPS.map((c) => (
        <div key={c.k} style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 14px" }}>
          <Icon name={c.icon} size={14} color="var(--fg-muted)" />
          <span style={{ fontSize: 12.5, color: "var(--fg)", whiteSpace: "nowrap" }}>{c.label}</span>
          <span style={{ flex: 1 }} />
          <TriState value={state[c.k]} onChange={(v) => set(c.k, v)} />
        </div>
      ))}
    </Group>
  );
}

/* ----------------------------- 3. Repository --------------------------- */
function TreeView({ data, openInit = [] }: { data: TreeNode[]; openInit?: string[] }) {
  const [open, setOpen] = useState<Set<string>>(new Set(openInit));
  const toggle = (p: string) => setOpen((s) => { const n = new Set(s); if (n.has(p)) n.delete(p); else n.add(p); return n; });
  const Node = ({ node, depth, base }: { node: TreeNode; depth: number; base: string }) => {
    const path = base ? base + "/" + node.name : node.name;
    const isOpen = open.has(path);
    const isDir = node.type === "dir";
    return (
      <>
        <div onClick={() => isDir && toggle(path)} style={{ display: "flex", alignItems: "center", gap: 7, padding: "5px 14px", paddingLeft: 14 + depth * 16, cursor: isDir ? "pointer" : "default", fontSize: 12.5 }}>
          {isDir
            ? <Icon name="caret" size={12} color="var(--fg-dim)" style={{ transform: isOpen ? "none" : "rotate(-90deg)", transition: ".15s" }} />
            : <span style={{ width: 12, flex: "0 0 auto" }} />}
          {isDir
            ? <Icon name="folder" size={14} color={isOpen ? "var(--accent)" : "var(--fg-muted)"} />
            : <span style={{ background: EXT_COLOR[extOf(node.name)] ?? "var(--fg-dim)", width: 6, height: 6, borderRadius: "50%", flex: "0 0 auto", marginLeft: 3, marginRight: 1 }} />}
          <span style={{ fontFamily: isDir ? "var(--sans)" : "var(--mono)", fontSize: isDir ? 12.5 : 11.5, color: "var(--fg)", fontWeight: isDir ? 500 : 400 }}>{node.name}</span>
          {node.git && <><span style={{ flex: 1 }} /><span style={{ fontFamily: "var(--mono)", fontSize: 9, fontWeight: 600, color: node.git === "M" ? "var(--accent)" : "var(--success)" }}>{node.git}</span></>}
        </div>
        {isDir && isOpen && node.children?.map((c) => <Node key={c.name} node={c} depth={depth + 1} base={path} />)}
      </>
    );
  };
  return <div style={{ padding: "2px 0" }}>{data.map((n) => <Node key={n.name} node={n} depth={0} base="" />)}</div>;
}
function RepositorySection() {
  return (
    <Group icon="github" title="Repository" actions={<IconBtn icon="refresh" title="Refresh" />}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 14px 12px" }}>
        <span style={{ width: 30, height: 30, flex: "0 0 auto", borderRadius: 8, background: "var(--bg-elev2)", border: "1px solid var(--border)", display: "grid", placeItems: "center" }}>
          <Icon name="github" size={17} color="var(--fg)" />
        </span>
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{ display: "block", fontSize: 13, fontWeight: 600, color: "var(--fg)" }}>acme<span style={{ color: "var(--fg-dim)" }}>/</span>base-studio</span>
          <span style={{ display: "flex", alignItems: "center", gap: 5, marginTop: 2 }}>
            <Icon name="branch" size={11} color="var(--fg-dim)" />
            <span style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--fg-muted)" }}>main</span>
            <span style={{ width: 3, height: 3, borderRadius: "50%", background: "var(--success)", margin: "0 2px" }} />
            <span style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--fg-dim)" }}>synced</span>
          </span>
        </span>
      </div>
      <div style={DIVIDER} />
      <TreeView data={REPO_TREE} openInit={["src", "src/auth"]} />
    </Group>
  );
}

/* ------------------------------ the pane ------------------------------- */
export function ProjectPane() {
  return (
    <div style={{ borderRadius: 6, border: "1px solid var(--border-soft)", background: "var(--bg-panel)", overflow: "hidden", flexShrink: 0 }}>
      <FilesSection />
      <div style={{ ...DIVIDER, margin: "4px 14px" }} />
      <PermissionsSection />
      <div style={{ ...DIVIDER, margin: "4px 14px" }} />
      <RepositorySection />
    </div>
  );
}
