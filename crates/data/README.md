# bsc-data

The data-platform substrate for base-studio-code — the canonical **Data Model** store
(#781) and the **connector framework** (#784). See `docs/data-platform-spec.md` for the
full design and `docs/data-platform-spec.md §9` for the locked decisions.

## What it does

Connectors **read** from a source into a `RowSet`; the store materializes a `DataModel`
as typed DuckDB tables and **loads** rows into it with per-row lineage. It is strictly
read-only with respect to the source — nothing ever writes back to a system of record
(decided #782).

## Modules

| Module | Role |
|---|---|
| `schema` | The canonical `DataModel` / `Entity` / `Field` (+ `check()`), JSON-compatible with the TS authoring side (#780). |
| `ddl` | Pure SQL generation — identifier safety (untrusted keys are whitelisted, never escaped), type mapping, and per-type cell coercion. No DuckDB dependency. |
| `connector` | The read-only `Connector` trait + the reference `CsvConnector` + `RowSet`. |
| `store` | The DuckDB-backed `DataStore`: typed tables, coerced loads, and a `_lineage` table. **Feature-gated** (`duckdb-store`, on by default). |
| `error` | Typed `DataError` / `Result`. |

## Building & testing

```bash
# Fast — the schema/ddl/connector/coercion logic, no bundled C++ build:
cargo test -p bsc-data --no-default-features

# Full — compiles bundled DuckDB and runs the store integration tests:
cargo test -p bsc-data
```

The crate is a workspace member but is **not** yet a dependency of `src-tauri`, so the
main build / CI (which targets the `src-tauri` manifest) does not compile DuckDB.

## Next steps

- **Wire Tauri commands** (`data_open_store`, `data_apply_model`, `data_load_csv`,
  `data_counts`, …) once there's a UI consumer — this is when DuckDB enters the main
  build. Gate behind the data feature so non-data builds stay lean.
- **MCP connectors** (#784): package further connectors (SQL, Salesforce Bulk API,
  OData/SAP) as MCP servers reusing #33, each exposing the same `objects` / `read`
  surface. The CSV connector is the in-process reference.
- **Reconciliation** (#785): multi-source merge by `Entity::identity` + source precedence,
  building on the lineage this crate already records.
