# Vector Analysis Search for Algorithms

**Request:** #401 — "Vector-based semantic search for algorithms"  
**Status:** SHIPPED, with three deliberate departures from this design — see *What shipped* below  
**Designed:** 2026-09-22 · **Shipped:** 2026-09-28 (`a-record-and-its-tests-are-findable-by-what-they-DO`)

## What shipped, and where it departs from this document

`bsc algorithms search --query "<what it does>"` is live. Read this section before the design below,
because three parts of that design are **wrong for what was built** and following them would produce a
verb that returns nothing.

**1 · No embedding model. The engine is TF-IDF cosine.** This document specifies `embed(record)` and
`embed(query)` without ever naming a model or saying where one would run. `crates/bsc-similar` already
did document distance with TF-IDF term vectors and **zero dependencies**, and it is what `bsc surface
similar` and `bsc surface dupes` already run on — so that is the engine. It is deterministic, offline,
needs no download, and can name the terms that produced a score. The motivating failure was a **local**
model unable to find its files, so "works with no network and no model" was a requirement, not a
preference. Synonymy is the known cost: *paginate* will not find *chunk into pages*. A local embedding
model is the next rung and the trigger for adding one is a measured recall failure.

**2 · The thresholds do not transfer.** The bands below — 0.85 / 0.70 / 0.65 — assume embeddings. Against
a TF-IDF cosine a **short query scores structurally low on a long document**, because the document's
vector is spread over hundreds of terms the query never mentions. Measured on the real store, the best
genuine hits are **0.47** (a near-verbatim header match), 0.38 and 0.28. The floor is **0.05**, and
`--min-score` overrides it. A 0.65 floor would return nothing at all.

**3 · Tests are indexed, and so is each record's doc header.** This document covers records only. A test
names a *behaviour* where an implementation names types, so it is often the better index, and it is
indexed as its own document. So is each record's leading `//!` / `///` prose — and that one is not
cosmetic. TF-IDF cosine normalises by length, and this store mixes 200-byte leaves with a 679 KB module,
so **a large record that IS the answer loses to a tiny leaf sharing two terms**. Measured: before header
indexing, a query lifted almost verbatim from `bsc-similar--lib.rs`'s own header did not return that
record at all. With it, that record is the top hit at 0.468.

**Also worth knowing, and not in the design below:** the verb reads the **committed** store
(`repo_store::read_at`), lane-aware — not the shared runtime ledger, which was measured a week stale and
266 records short, missing the very record a test query was looking for.

### The performance target is MISSED, by about 4×

The success criteria below ask for **< 500ms** over the corpus. Measured 2026-09-28 over 3,211 records
(~7,000 documents once headers and tests are counted): **~350ms to load, ~1,650ms to search**, so ~2.0s
end to end, stable across runs. The load is not the cost — building the corpus is. That is the argument
for persisting an index, which was **not** done, because an index needs invalidating on every
`impl set` and a stale search index is worse than a slow one. That trade is a separate decision.

---

*Everything below is the design as proposed on 2026-09-22, kept for its reasoning. Where it conflicts
with the section above, the section above is what exists.*

## Problem

The current `bsc algorithms similar --sig` command searches on function signatures (contract-based), not on semantic content. With 3,037 algorithm records across rust/typescript and 4 role types, manual browsing is impractical. Agents need to query implementations by natural language descriptions of behavior, not just by signature patterns.

**Example failing query:**
```bash
# Current approach — requires exact signature knowledge
bsc algorithms similar --sig "fn paginate<T>(items: Vec<T>, page: u32, size: u32) -> Paginated<T>" --min-similarity 0.34

# Desired approach — natural language query
bsc algorithms search --query "paginate a collection into pages with offset and size" --tech rust --limit 10
```

## Design

### Embedding Fields

Each algorithm record has 12 fields. The vector embedding will combine:

| Field | Weight | Rationale |
|-------|--------|-----------|
| `name` | 1.0 | The identifier — concise semantic signal |
| `role` | 0.8 | Classifies the record type (algorithm, component, etc.) |
| `tech` | 0.6 | Technology domain (rust, typescript) |
| `code` | 2.0 | Full implementation text + prose documentation — the richest semantic content |
| `composes` | 0.5 | Relationship edges to other records |

**Composite embedding formula:**
```
embedding(record) = weighted_sum([
  embed(name) * 1.0,
  embed(role) * 0.8,
  embed(tech) * 0.6,
  embed(code) * 2.0,
  embed(composes) * 0.5
])
```

The `code` field carries the highest weight (2.0) as it contains the implementation logic and its documentation — the core semantic content an agent queries for.

### Similarity Model

**Cosine similarity** is the similarity function:
```
similarity(query, record) = (query_vector · record_vector) / (||query_vector|| * ||record_vector||)
```

**Scoring approach:**
1. Transform the natural language query into a vector using the same embedding model
2. Compute cosine similarity against each record's composite embedding
3. Apply filters (tech, role) before ranking
4. Return matches above a configurable threshold (default: 0.65)

**Thresholds:**
- `0.85+` — excellent match (same behavior, different implementation)
- `0.70-0.84` — strong match (related functionality)
- `0.65-0.69` — relevant match (domain alignment)
- `< 0.65` — below relevance threshold

### Command Interface

```bash
bsc algorithms search --query "<text>" [options]

Required:
  --query <text>      Natural language description of the desired algorithm

Filters:
  --tech <rust|typescript>  Filter by technology
  --role <role>             Filter by role (algorithm, component, etc.)
  --tags <tag1,tag2>        Filter by tags (comma-separated)

Ranking:
  --limit <N>               Maximum matches to return (default: 10)
  --min-similarity <0.0-1.0> Minimum similarity threshold (default: 0.65)
  --weight-code <N>         Adjust code field weight (default: 2.0)

Output:
  --json                    Return results as JSON
  --format <table|list>     Output format (default: table)
```

**Example queries:**

```bash
# Find pagination implementations
bsc algorithms search --query "paginate a collection into pages with offset and size" --tech rust --limit 10

# Search for tree traversal algorithms
bsc algorithms search --query "traverse a tree structure depth-first or breadth-first" --min-similarity 0.75 --json

# Find data transformation utilities
bsc algorithms search --query "transform and map data between formats" --role algorithm --tags "transform,utility" --limit 20
```

### Implementation Approach

**Phase 1: Embedding generation**
- Generate embeddings for all 3,037 existing records
- Store embeddings in a vector index (SQLite with vector extension, or dedicated vector store)
- Index supports incremental updates for new records

**Phase 2: Query interface**
- Implement `bsc algorithms search` command
- Query parsing and vector transformation
- Similarity scoring with filtering and ranking

**Phase 3: Integration**
- Wire into the gate and CI
- Add test queries against known algorithm records
- Document the command surface

### Command Structure (Rust)

```rust
pub struct SearchQuery {
    pub text: String,              // Natural language query
    pub tech: Option<Tech>,         // Filter: rust | typescript
    pub role: Option<Role>,         // Filter: algorithm | component | …
    pub tags: Vec<String>,          // Filter by tags
    pub limit: usize,               // Max results (default: 10)
    pub min_similarity: f32,        // Threshold (default: 0.65)
    pub weight_code: f32,           // Code field weight (default: 2.0)
}

pub struct SearchResult {
    pub id: String,
    pub name: String,
    pub tech: Tech,
    pub role: Role,
    pub similarity: f32,
    pub tags: Vec<String>,
    pub code_preview: String,       // First N lines of implementation
}

pub fn search_algorithms(
    query: SearchQuery,
    embeddings: &VectorIndex
) -> Vec<SearchResult> {
    // 1. Embed the query text
    let query_vector = embed(&query.text);
    
    // 2. Filter records by tech/role/tags
    let filtered = filter_records(query.tech, query.role, &query.tags);
    
    // 3. Compute similarity scores
    let scored = filtered.iter()
        .map(|r| (r.id, cosine_similarity(&query_vector, &r.embedding)))
        .filter(|(_, sim)| *sim >= query.min_similarity)
        .collect();
    
    // 4. Sort and limit
    scored.into_iter()
        .sorted_by(|a, b| b.1.partial_cmp(&a.1).unwrap())
        .take(query.limit)
        .map(|(id, sim)| build_result(id, sim))
        .collect()
}
```

### Success Criteria

1. **Semantic relevance:** Queries return results that match the described behavior, not just signature patterns
2. **Performance:** Search completes in < 500ms for the full 3,037 record corpus
3. **Threshold tuning:** Default 0.65 threshold returns 5-15 relevant matches for typical queries
4. **Filter integration:** Tech/role/tag filters reduce result set while maintaining relevance
5. **Output clarity:** JSON and table formats show similarity scores and code previews

### Next Steps

1. Generate embeddings for the existing record corpus
2. Implement the `bsc algorithms search` command
3. Test with representative queries (pagination, tree traversal, data transformation)
4. Tune weights and thresholds based on initial results
5. Add the command to the surface documentation

---

**Related:** Request #401, epic-command-surfaces-are-nodes, the-algorithms-page-blanks-when-records-sit-on-a-lane
