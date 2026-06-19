//! Pure SQL generation + value coercion for the store.
//!
//! Kept free of any DuckDB dependency so the bulk of the store's logic — identifier
//! safety, the DDL it emits, and how raw cells coerce to typed values — is unit-tested
//! without the bundled C++ build.

use crate::error::{DataError, Result};
use crate::schema::{Entity, FieldType};

/// Name of the per-row lineage table every store carries.
pub const LINEAGE_TABLE: &str = "_lineage";

/// Name of the per-field lineage table (reconciliation, #785): which source supplied the
/// winning value for each field of each reconciled record.
pub const FIELD_LINEAGE_TABLE: &str = "_field_lineage";

/// Validate an entity/field key as a SQL identifier and return it double-quoted.
///
/// Entity/field keys originate from a Data Model authored by a user or agent, so they
/// are untrusted. We allow only `[A-Za-z_][A-Za-z0-9_]*` and reject everything else —
/// no escaping games, no injection surface.
pub fn quote_ident(name: &str) -> Result<String> {
    let mut chars = name.chars();
    let ok = match chars.next() {
        Some(c) if c.is_ascii_alphabetic() || c == '_' => {
            chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
        }
        _ => false,
    };
    if ok {
        Ok(format!("\"{name}\""))
    } else {
        Err(DataError::Schema(format!("unsafe identifier `{name}`")))
    }
}

/// The DuckDB column type for a logical field type.
pub fn column_type(ty: FieldType) -> &'static str {
    match ty {
        FieldType::String | FieldType::Ref | FieldType::Enum | FieldType::Date => "VARCHAR",
        FieldType::Number => "DOUBLE",
        FieldType::Money => "DECIMAL(18,2)",
        FieldType::Bool => "BOOLEAN",
    }
}

/// `CREATE TABLE IF NOT EXISTS` for an entity. Columns are the entity's fields, in order.
pub fn create_table_sql(entity: &Entity) -> Result<String> {
    if entity.fields.is_empty() {
        return Err(DataError::Schema(format!("entity `{}` has no fields", entity.key)));
    }
    let cols = entity
        .fields
        .iter()
        .map(|f| Ok(format!("{} {}", quote_ident(&f.key)?, column_type(f.ty))))
        .collect::<Result<Vec<_>>>()?
        .join(", ");
    Ok(format!(
        "CREATE TABLE IF NOT EXISTS {} ({cols})",
        quote_ident(&entity.key)?
    ))
}

/// `CREATE TABLE IF NOT EXISTS` for the lineage table — one row per loaded record,
/// recording where it came from, when, and under what license.
pub fn lineage_ddl() -> String {
    format!(
        "CREATE TABLE IF NOT EXISTS {LINEAGE_TABLE} \
         (entity VARCHAR, row_key VARCHAR, source VARCHAR, loaded_at VARCHAR, license VARCHAR)"
    )
}

/// `CREATE TABLE IF NOT EXISTS` for the per-field lineage table — one row per reconciled
/// (record, field) recording which source won (#785). Includes `license` for full provenance.
pub fn field_lineage_ddl() -> String {
    format!(
        "CREATE TABLE IF NOT EXISTS {FIELD_LINEAGE_TABLE} \
         (entity VARCHAR, identity VARCHAR, field VARCHAR, \
          source VARCHAR, loaded_at VARCHAR, license VARCHAR)"
    )
}

/// `INSERT INTO entity (cols…) VALUES (?, ?, …)` with one placeholder per field.
pub fn insert_sql(entity: &Entity) -> Result<String> {
    let cols = entity
        .fields
        .iter()
        .map(|f| quote_ident(&f.key))
        .collect::<Result<Vec<_>>>()?
        .join(", ");
    let placeholders = vec!["?"; entity.fields.len()].join(", ");
    Ok(format!(
        "INSERT INTO {} ({cols}) VALUES ({placeholders})",
        quote_ident(&entity.key)?
    ))
}

/// A raw string cell coerced to a typed value per its field type — pure, so the store
/// just maps the result onto a DuckDB value. An empty cell, or one that fails to parse
/// for a numeric/bool field, becomes [`Coerced::Null`] (a signal the quality gate can
/// later act on, #783).
#[derive(Debug, Clone, PartialEq)]
pub enum Coerced {
    Null,
    Text(String),
    Num(f64),
    Bool(bool),
}

/// Coerce a raw cell for a field type.
pub fn coerce(ty: FieldType, raw: &str) -> Coerced {
    let raw = raw.trim();
    if raw.is_empty() {
        return Coerced::Null;
    }
    match ty {
        FieldType::Number | FieldType::Money => raw
            .replace([',', '$'], "")
            .parse::<f64>()
            .map(Coerced::Num)
            .unwrap_or(Coerced::Null),
        FieldType::Bool => match raw.to_ascii_lowercase().as_str() {
            "true" | "t" | "1" | "yes" | "y" => Coerced::Bool(true),
            "false" | "f" | "0" | "no" | "n" => Coerced::Bool(false),
            _ => Coerced::Null,
        },
        // String / Date / Ref / Enum are stored as text in v1.
        _ => Coerced::Text(raw.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema::Field;

    fn entity() -> Entity {
        Entity {
            key: "account".into(),
            label: String::new(),
            fields: vec![
                Field { key: "id".into(), label: String::new(), ty: FieldType::String, required: true, reference: None, enum_values: vec![], validate: None },
                Field { key: "balance".into(), label: String::new(), ty: FieldType::Money, required: false, reference: None, enum_values: vec![], validate: None },
            ],
            identity: vec!["id".into()],
        }
    }

    #[test]
    fn rejects_unsafe_identifiers() {
        assert!(quote_ident("account").is_ok());
        assert!(quote_ident("_x9").is_ok());
        assert!(quote_ident("droptable; --").is_err());
        assert!(quote_ident("a-b").is_err());
        assert!(quote_ident("1abc").is_err());
        assert!(quote_ident("").is_err());
    }

    #[test]
    fn emits_typed_create_and_insert() {
        let e = entity();
        let create = create_table_sql(&e).unwrap();
        assert_eq!(create, "CREATE TABLE IF NOT EXISTS \"account\" (\"id\" VARCHAR, \"balance\" DECIMAL(18,2))");
        let insert = insert_sql(&e).unwrap();
        assert_eq!(insert, "INSERT INTO \"account\" (\"id\", \"balance\") VALUES (?, ?)");
    }

    #[test]
    fn empty_entity_has_no_table() {
        let e = Entity { key: "x".into(), label: String::new(), fields: vec![], identity: vec![] };
        assert!(create_table_sql(&e).is_err());
    }

    #[test]
    fn coerces_per_type_with_null_on_failure() {
        assert_eq!(coerce(FieldType::Number, "42"), Coerced::Num(42.0));
        assert_eq!(coerce(FieldType::Money, "$1,250.50"), Coerced::Num(1250.50));
        assert_eq!(coerce(FieldType::Number, "abc"), Coerced::Null);
        assert_eq!(coerce(FieldType::Bool, "Yes"), Coerced::Bool(true));
        assert_eq!(coerce(FieldType::Bool, "0"), Coerced::Bool(false));
        assert_eq!(coerce(FieldType::Bool, "maybe"), Coerced::Null);
        assert_eq!(coerce(FieldType::String, "  hi  "), Coerced::Text("hi".into()));
        assert_eq!(coerce(FieldType::String, ""), Coerced::Null);
    }
}
