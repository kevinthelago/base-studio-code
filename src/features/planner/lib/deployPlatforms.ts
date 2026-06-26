// Deploy target catalog (#919; per-repo rework #1421) — the platforms a service can ship to, the
// workload kinds, the git hosts a repo can live on, and the container orchestration options. Pure
// data (no React/Tauri) so it is unit-testable. Split out of deployConfig.ts (#1639).

/** Workload kind a service deploys as. */
export type Workload = "static" | "serverless" | "container" | "service";

export interface DeployPlatform {
  id: string;
  name: string;
  /** Workload kinds this platform supports. */
  kinds: Workload[];
  /** oklch hue for the platform tile glyph. */
  h: number;
  glyph: string;
}

/** Platform catalog — the deploy targets a service can pick. */
export const PLATFORMS: DeployPlatform[] = [
  { id: "vercel",     name: "Vercel",             kinds: ["static", "serverless"], h: 250, glyph: "▲" },
  { id: "netlify",    name: "Netlify",            kinds: ["static", "serverless"], h: 195, glyph: "◆" },
  { id: "cloudflare", name: "Cloudflare",         kinds: ["static", "serverless"], h: 70,  glyph: "☁" },
  { id: "fly",        name: "Fly.io",             kinds: ["container", "service"], h: 300, glyph: "✦" },
  { id: "railway",    name: "Railway",            kinds: ["container", "service"], h: 300, glyph: "◇" },
  { id: "render",     name: "Render",             kinds: ["container", "service"], h: 230, glyph: "◉" },
  { id: "aws",        name: "AWS",                kinds: ["serverless", "container", "service"], h: 70,  glyph: "❯" },
  { id: "gcp",        name: "GCP",                kinds: ["serverless", "container", "service"], h: 230, glyph: "◐" },
  { id: "azure",      name: "Azure",             kinds: ["serverless", "container", "service"], h: 250, glyph: "◭" },
  { id: "ghpages",    name: "GitHub Pages",       kinds: ["static"], h: 250, glyph: "⎇" },
  { id: "docker",     name: "Self-host · Docker", kinds: ["container"], h: 230, glyph: "⬢" },
  { id: "k8s",        name: "Self-host · K8s",    kinds: ["container", "service"], h: 230, glyph: "⎈" },
];
export function platform(id: string): DeployPlatform {
  return PLATFORMS.find((p) => p.id === id) ?? { id, name: id, h: 250, glyph: "■", kinds: [] };
}

export const WORKLOAD: Record<Workload, { label: string; c: string }> = {
  static:     { label: "static",       c: "var(--info)" },
  serverless: { label: "serverless",   c: "var(--accent)" },
  container:  { label: "container",    c: "var(--violet)" },
  service:    { label: "long-running", c: "var(--success)" },
};

/** A git host a project's repos can live on — a project may span clouds or a self-hosted server. */
export interface GitHost { key: string; domain: string; label: string; kind: "cloud" | "self-hosted"; color: string }
export const HOSTS: Record<string, GitHost> = {
  github:     { key: "github",     domain: "github.com",  label: "GitHub",      kind: "cloud",       color: "var(--info)" },
  gitlab:     { key: "gitlab",     domain: "gitlab.com",  label: "GitLab",      kind: "cloud",       color: "var(--accent)" },
  bitbucket:  { key: "bitbucket",  domain: "bitbucket.org", label: "Bitbucket", kind: "cloud",       color: "var(--info)" },
  selfhosted: { key: "selfhosted", domain: "self-hosted", label: "self-hosted", kind: "self-hosted", color: "var(--violet)" },
};
export function hostMeta(id: string | undefined): GitHost {
  return HOSTS[id ?? "github"] ?? HOSTS.github;
}

/** Orchestrators a distributed (container) workload can run under. */
export const ORCHESTRATORS: { id: string; label: string }[] = [
  { id: "k8s", label: "Kubernetes" }, { id: "swarm", label: "Docker Swarm" }, { id: "nomad", label: "Nomad" },
];
/** Replica-count options for a container workload (string so "auto" fits the same control). */
export const REPLICA_OPTIONS = ["1", "3", "5", "auto"] as const;
