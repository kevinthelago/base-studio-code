//! The `bsc component` subcommand (#2281) — the component-library shim over the shared verbatim-
//! JSON-per-id store CLI ([`bsc_json_store::cli`], #2158). TWO collections: the **components**
//! (`~/.base-studio-code/components/<id>.json`) and the **kits** (`~/.base-studio-code/kits/<id>.json`),
//! each list/get/set/remove-able from a session's own shell — the same store the desktop Component
//! Library pane reads/writes and an agent reaches to reuse a proven component instead of re-inventing it.
//!
//! `bsc component <cmd>` operates on components; `bsc component kit <cmd>` operates on kits. Dispatched
//! by the unified `bsc` binary (#1877) via [`run`]. Per-command help (#1762):
//!   bsc component help          # component commands
//!   bsc component kit help      # kit commands
//!   bsc component set help      # detailed help for ONE command
//!
//! Each collection resolves via `--dir <path>` or its env var, defaulting to `~/.base-studio-code/<seg>/`.

use bsc_cli_util::CmdDoc;
use bsc_json_store::cli::CliSpec;

const TAGLINE: &str = "the component library — proven components in technology-scoped kits (#2281)";
const KIT_TAGLINE: &str = "the component library's kits — technology-scoped component namespaces (#2281)";

const COMPONENT_COMMANDS: &[CmdDoc] = &[
    CmdDoc {
        name: "list",
        summary: "every component's {id, name, kitId, role} (JSON)",
        usage: "\
USAGE:
  bsc component list [--full] [--pretty]

Prints every component's { id, name, kitId, role } as JSON (compact; --pretty for indented). --full
emits the COMPLETE component objects (variants + props + composes + guidance + source + …) as a plain
array — the full-fidelity read the desktop library hydration needs.",
    },
    CmdDoc {
        name: "get",
        summary: "print one component (JSON, verbatim) or null",
        usage: "\
USAGE:
  bsc component get <id> [--pretty]

Prints the stored component JSON for <id> verbatim, or `null` if absent.",
    },
    CmdDoc {
        name: "set",
        summary: "upsert from component JSON on stdin; prints id(s)",
        usage: "\
USAGE:
  bsc component set [--pretty]   # component JSON (one object or an array) on stdin

Upserts each component by its (required, non-empty) \"id\" field, written verbatim. Prints the id(s)
written — how an agent (or the pane) authors/updates a component in the shared kit.",
    },
    CmdDoc {
        name: "remove",
        summary: "delete a component (no-op if absent)",
        usage: "\
USAGE:
  bsc component remove <id> [--pretty]

Deletes the component keyed by <id>. A no-op (not an error) when it does not exist.",
    },
    CmdDoc {
        name: "kit",
        summary: "operate on the KITS instead of the components",
        usage: "\
USAGE:
  bsc component kit list [--full] [--pretty]   # every kit's { id, name, stack }
  bsc component kit get <id> [--pretty]
  bsc component kit set [--pretty]             # kit JSON on stdin (upsert by id)
  bsc component kit remove <id> [--pretty]

A kit is a technology-scoped namespace of components ({ id, name, stack, dot }). `bsc component kit …`
is the same list/get/set/remove over the kit collection.",
    },
];

const KIT_COMMANDS: &[CmdDoc] = &[
    CmdDoc {
        name: "list",
        summary: "every kit's {id, name, stack} (JSON)",
        usage: "\
USAGE:
  bsc component kit list [--full] [--pretty]

Every kit's { id, name, stack } as JSON (compact; --pretty for indented). --full emits the complete
kit objects (incl. the dot color) as a plain array.",
    },
    CmdDoc {
        name: "get",
        summary: "print one kit (JSON, verbatim) or null",
        usage: "USAGE:\n  bsc component kit get <id> [--pretty]\n\nThe stored kit JSON for <id> verbatim, or `null` if absent.",
    },
    CmdDoc {
        name: "set",
        summary: "upsert from kit JSON on stdin; prints id(s)",
        usage: "USAGE:\n  bsc component kit set [--pretty]   # kit JSON (object or array) on stdin\n\nUpserts each kit by its \"id\", written verbatim.",
    },
    CmdDoc {
        name: "remove",
        summary: "delete a kit (no-op if absent)",
        usage: "USAGE:\n  bsc component kit remove <id> [--pretty]\n\nDeletes the kit keyed by <id>; a no-op when absent.",
    },
];

/// The component collection's knobs over the shared CLI. Lean `list` projects id/name/kitId/role.
const COMPONENT_SPEC: CliSpec = CliSpec {
    noun: "component",
    dir_env: "BSC_COMPONENT_DIR",
    dir_segment: "components",
    tagline: TAGLINE,
    commands: COMPONENT_COMMANDS,
    meta_fields: &["id", "name", "kitId", "role"],
};

/// The kit collection's knobs. Lean `list` projects id/name/stack.
const KIT_SPEC: CliSpec = CliSpec {
    noun: "kit",
    dir_env: "BSC_COMPONENT_KIT_DIR",
    dir_segment: "kits",
    tagline: KIT_TAGLINE,
    commands: KIT_COMMANDS,
    meta_fields: &["id", "name", "stack"],
};

/// The `component` subcommand entrypoint: `args` is everything after `bsc component`; `prog` is the
/// display name for help/errors. `bsc component kit …` routes to the KIT collection; everything else to
/// the COMPONENT collection — each is the shared verbatim-JSON store CLI over its own dir.
pub fn run(args: Vec<String>, prog: &str) -> Result<(), String> {
    if args.first().map(String::as_str) == Some("kit") {
        let kit_prog = format!("{prog} kit");
        return bsc_json_store::cli::run(args.into_iter().skip(1).collect(), &kit_prog, &KIT_SPEC);
    }
    bsc_json_store::cli::run(args, prog, &COMPONENT_SPEC)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn specs_are_the_two_collections_with_the_right_lean_fields() {
        assert_eq!(COMPONENT_SPEC.noun, "component");
        assert_eq!(COMPONENT_SPEC.dir_segment, "components");
        assert_eq!(COMPONENT_SPEC.meta_fields, &["id", "name", "kitId", "role"]);
        assert_eq!(KIT_SPEC.noun, "kit");
        assert_eq!(KIT_SPEC.dir_segment, "kits");
        assert_eq!(KIT_SPEC.meta_fields, &["id", "name", "stack"]);
        // The two collections live in DIFFERENT dirs (a component and a kit can share an id).
        assert_ne!(COMPONENT_SPEC.dir_segment, KIT_SPEC.dir_segment);
        assert_ne!(COMPONENT_SPEC.dir_env, KIT_SPEC.dir_env);
    }

    #[test]
    fn component_help_lists_commands_incl_the_kit_pointer() {
        let ov = bsc_cli_util::help_overview("bsc component", TAGLINE, COMPONENT_COMMANDS);
        for c in ["list", "get", "set", "remove", "kit"] {
            assert!(ov.contains(c), "overview lists {c}");
        }
        // The kit pointer's detail explains the sub-noun.
        let kit = bsc_cli_util::help_for("bsc component", TAGLINE, COMPONENT_COMMANDS, "kit");
        assert!(kit.contains("bsc component kit"));
    }

    #[test]
    fn kit_help_lists_the_kit_crud() {
        let ov = bsc_cli_util::help_overview("bsc component kit", KIT_TAGLINE, KIT_COMMANDS);
        for c in ["list", "get", "set", "remove"] {
            assert!(ov.contains(c), "kit overview lists {c}");
        }
    }
}
