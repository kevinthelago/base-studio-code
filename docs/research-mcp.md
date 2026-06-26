# Research MCP — native, built-in literature grounding (#1196)

**Status:** ✅ implemented · **Scope:** Rust crate `crates/research` + bundled `bsc-research-mcp` sidecar + frontend built-in wiring.

The **Research** capability (literature search/retrieval + native PDF extraction + citation-grounded
semantic search — the planner's source-grounding for plans & skills, #1056) ships **built into the
app**. There is **no download, no `pnpm`/Node build, and no Docker/GROBID** — it's a compiled Rust
binary bundled beside the app exe and auto-registered for every session.

> "Preserve the contract, swap the producer." The agent-facing MCP tool surface is the contract; the
> native crate is the producer that replaced the former external `research-mcp-server`.

## What it does

A stdio MCP server exposing five tools:

| Tool | Purpose |
|---|---|
| `search` | Search across arXiv · Semantic Scholar · PubMed/PMC · Crossref. Normalized records (title, authors, year, abstract, ids, urls), newest-first, deduped across sources. |
| `get_paper` | Fetch one record's full metadata by canonical id. |
| `get_fulltext` | Download + **natively extract** a paper's full text from its PDF (no Docker). |
| `get_references` | Resolve a paper's reference list (DOIs/arXiv ids via Crossref/Semantic Scholar). |
| `semantic_search` | Citation-grounded passage retrieval over a set of papers — chunks each paper by section and BM25-ranks, returning passages tagged with `paper_id` + `section`. |

**Canonical ids:** `arxiv:<id>`, `doi:<doi>`, `pmid:<id>`, `s2:<paperId>`.

## How it's delivered

- **Crate `crates/research`** — `types`/`http`/`cache` + per-source clients (`sources/*`, each a pure
  fixture-tested parser plus a thin network entry point) + `pdf` (native extraction via `pdf-extract`
  + section-aware chunking) + `search` (BM25) + `engine` + `mcp` (the JSON-RPC server). The
  `[[bin]] bsc-research-mcp` is the server.
- **Bundling** — listed in `tauri.conf.json` `externalBin`, staged by `scripts/stage-sidecar.mjs`
  (`BINS`) and `npm run build:plan`, resolved at runtime via `current_exe().with_file_name(...)`
  (`bsc_research_mcp_bin_path` in `src-tauri/src/console/pty.rs`) — exactly like `bsc-plan`/`bsc-agent`.
- **Registration** — the frontend marks Research a built-in server (`BUILTIN_MCP_SERVERS` in
  `src/features/mcp/lib/mcpServers.ts`, command marker `bsc-research-mcp`); it's merged into
  `resolveMcpServers` / `resolveAllInstalledMcp` so the planner, director, and every worker get it by
  default, and it stays assignable per-worker via a stream's `mcp` list. When writing `.mcp.json`,
  `mcp_server_value` (`src-tauri/src/extensions/mcp.rs`) rewrites the marker to the bundled binary's absolute
  path (Claude Code spawns `.mcp.json` commands directly, with no PATH/shell-rc).
- **MCP screen** — Research appears under **Built-in tools** (always available), not the downloadable
  browse list.

## API keys & rate limits (all optional)

Every source works **key-less**. Keys only raise rate limits and are read from env (the standard MCP
env mechanism the app injects):

| Env var | Source | Effect |
|---|---|---|
| `SEMANTIC_SCHOLAR_API_KEY` | Semantic Scholar | higher rate limits |
| `NCBI_API_KEY` | PubMed/PMC E-utilities | higher rate limits |
| `CROSSREF_MAILTO` | Crossref | "polite pool" (recommended) |

## Caching

Fetched records, extracted full text, and search results are cached in SQLite at
`~/.base-studio-code/research/cache.db` (override with `$BSC_RESEARCH_CACHE`) so repeated grounding
is fast/offline-friendly and stays within upstream rate limits. The cache is a pure optimization —
every miss falls through to the network, so a missing/corrupt cache never breaks a call.

## Skills

Skill authoring stays with the **planner** (#1056/#1086): the Research tools surface the latest,
best literature; the planner reads them and writes grounded skills. The tool is the grounding engine,
not a skill generator.

## Notes / future

- **Semantic search** defaults to offline BM25 (key-less, dependency-free). An optional API embedder
  (Voyage/OpenAI) can rerank when a key is configured — a future enhancement; BM25 is the baseline.
- The external `research-mcp-server` repo is superseded by this native path and should be annotated
  as deprecated (not deleted), per repo convention.
