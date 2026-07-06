bsc-note() { d="${BSC_DECISIONS_DOC:-$PWD/DECISIONS.md}"; mkdir -p "$(dirname "$d")" 2>/dev/null; { printf '%s' "- [${BSC_AUDIT_PANE:-?}] "; cat; printf '\n'; } >> "$d"; }
