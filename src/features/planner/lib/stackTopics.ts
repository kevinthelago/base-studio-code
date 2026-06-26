// Stack detection (#848 / #1710): the single regex-based matcher over a project's stack-section
// prose. Two consumers share it — `deriveTopics` (→ GitHub repo topics) and `gettingStartedCmds`
// (→ the README's install/run commands). Kept as TS (RegExp literals, not JSON) so the patterns
// stay first-class and case-insensitive whole-word matching is expressible.

/**
 * Test a stack-pattern against already-lowercased stack text. Centralizes the match step so both
 * the topic map and the getting-started toolchains run through one place.
 */
function matchesStack(lowerText: string, re: RegExp): boolean {
  return re.test(lowerText);
}

// Curated stack-keyword → GitHub-topic-slug map. Matched case-insensitively as whole words
// against the stack section text, so prose like "React 18 + TypeScript, Rust (Tauri)" yields
// `react`, `typescript`, `rust`, `tauri`. Lowercase-hyphenated per the topic-hygiene guide.
export const STACK_TOPICS: [RegExp, string][] = [
  [/\breact\b/, "react"], [/\bnext\.?js\b/, "nextjs"], [/\bvue\b/, "vue"], [/\bsvelte\b/, "svelte"],
  [/\bangular\b/, "angular"], [/\btypescript\b/, "typescript"], [/\bjavascript\b/, "javascript"],
  [/\bnode(\.?js)?\b/, "nodejs"], [/\bdeno\b/, "deno"], [/\bbun\b/, "bun"], [/\bvite\b/, "vite"],
  [/\brust\b/, "rust"], [/\btauri\b/, "tauri"], [/\bgo(lang)?\b/, "go"], [/\bpython\b/, "python"],
  [/\bdjango\b/, "django"], [/\bflask\b/, "flask"], [/\bfastapi\b/, "fastapi"], [/\bruby\b/, "ruby"],
  [/\brails\b/, "rails"], [/\bjava\b/, "java"], [/\bspring\b/, "spring-boot"], [/\bkotlin\b/, "kotlin"],
  [/\bswift\b/, "swift"], [/\bc\+\+\b/, "cpp"], [/\bc#\b/, "csharp"], [/\b\.net\b/, "dotnet"],
  [/\bpostgres(ql)?\b/, "postgresql"], [/\bmysql\b/, "mysql"], [/\bsqlite\b/, "sqlite"],
  [/\bmongo(db)?\b/, "mongodb"], [/\bredis\b/, "redis"], [/\bduckdb\b/, "duckdb"],
  [/\bgraphql\b/, "graphql"], [/\bdocker\b/, "docker"], [/\bkubernetes\b|\bk8s\b/, "kubernetes"],
  [/\btailwind\b/, "tailwindcss"], [/\bexpo\b/, "expo"], [/\breact native\b/, "react-native"],
];

// Toolchain → install/run commands, matched against the stack text the same way as STACK_TOPICS.
// First entry whose pattern hits contributes its commands; multiple may match (e.g. Tauri → both
// npm and cargo). Falls back to a generic comment when nothing is recognized.
const STACK_TOOLCHAINS: [RegExp, string[]][] = [
  [/\bnode(\.?js)?\b|\bnpm\b|\bvite\b|\breact\b|\bnext\b|\btypescript\b|\btauri\b/, ["npm install", "npm run dev"]],
  [/\bcargo\b|\brust\b|\btauri\b/, ["cargo build", "cargo run"]],
  [/\bpython\b|\bdjango\b|\bflask\b|\bfastapi\b/, ["pip install -r requirements.txt"]],
  [/\bgo(lang)?\b/, ["go mod download", "go run ."]],
];

/**
 * Derive GitHub repo topics from the stack section text, plus any explicit extras. Whole-word,
 * case-insensitive; deduped; lowercase-hyphenated; capped at GitHub's 20-topic limit. NB: these
 * are GitHub *repo topics*, distinct from the planner's discovery "topics".
 */
export function deriveTopics(stackText: string, extra: string[] = []): string[] {
  const found: string[] = [];
  const text = stackText.toLowerCase();
  for (const [re, topic] of STACK_TOPICS) {
    if (matchesStack(text, re)) found.push(topic);
  }
  const clean = (t: string) => t.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  const all = [...found, ...extra.map(clean)].filter(Boolean);
  return [...new Set(all)].slice(0, 20);
}

/**
 * A stack-aware Getting-started body. Detects the toolchain from the stack text and emits the
 * right install/run commands (npm / cargo / pip / go), falling back to a generic comment when
 * nothing is recognized. Returns the lines *inside* the ```bash fence (clone is added by the caller).
 */
export function gettingStartedCmds(stackText: string): string[] {
  const s = stackText.toLowerCase();
  const out: string[] = [];
  for (const [re, cmds] of STACK_TOOLCHAINS) {
    if (matchesStack(s, re)) out.push(...cmds);
  }
  return out.length ? out : ["# install dependencies and run the project's build/test/dev commands"];
}
