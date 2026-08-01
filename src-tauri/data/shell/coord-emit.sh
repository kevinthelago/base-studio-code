__bsc_coord() { l="${BSC_COORD_LOG:-}"; [ -z "$l" ] && return 0; ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"; __bsc_logline "$l" '%s\t%s\t%s\t%s\t%s\n' "$ts" "${BSC_AUDIT_PANE:-?}" "$1" "$2" "$3"; }
__bsc_coord_log() { l="${BSC_COORD_LOG:-}"; [ -z "$l" ] && return 0; ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"; __bsc_logline "$l" '%s\t%s\t%s\n' "$ts" "${BSC_AUDIT_PANE:-?}" "$1"; }
bsc-landed() { __bsc_coord landed "$1" ""; }
bsc-merged() { __bsc_coord merged "$1" ""; }
bsc-closed() { __bsc_coord closed "$1" ""; }
bsc-failed() { r="$(cat)"; __bsc_coord failed "$1" "$r"; }
bsc-wait() { r="$(cat)"; __bsc_coord waiting "$r" "${BSC_CHECKPOINT_DOC:-}"; }
bsc-maintain() { r="$(cat | tr '\t\n' '  ')"; __bsc_coord maintain "$r" "${BSC_CHECKPOINT_DOC:-}"; }
bsc-ask() { r="$(cat | tr '\t\n' '  ')"; __bsc_coord ask "$r" "${BSC_CHECKPOINT_DOC:-}"; }
bsc-answer() { tgt="$1"; a="$(cat | tr '\t\n' '  ')"; __bsc_coord answer "$tgt" "$a"; }
# Flag values read as "${2-}" + `shift 2 2>/dev/null || shift`: a dangling flag (e.g. an unquoted
# `--ref #77` whose value bash ate as a comment) must fall through, not spin — `shift 2` with one
# arg left shifts NOTHING, which loops these parsers forever (#2414).
bsc-issue() { t=""; s=""; id=""; while [ $# -gt 0 ]; do case "$1" in --title) t="${2-}"; shift 2 2>/dev/null || shift ;; --suggested) s="${2-}"; shift 2 2>/dev/null || shift ;; --id) id="${2-}"; shift 2 2>/dev/null || shift ;; *) shift ;; esac; done; t="$(printf '%s' "$t" | tr '\t\n' '  ')"; s="$(printf '%s' "$s" | tr '\t\n' '  ')"; id="$(printf '%s' "$id" | tr '\t\n' '  ')"; b="$(cat | tr '\t\n' '  ')"; __bsc_coord_log "issue	$t	$b	$s	$id"; }
bsc-assign() { tgt="$1"; [ $# -gt 0 ] && shift; id=""; t=""; while [ $# -gt 0 ]; do case "$1" in --issue) id="${2-}"; shift 2 2>/dev/null || shift ;; --title) t="${2-}"; shift 2 2>/dev/null || shift ;; *) shift ;; esac; done; tgt="$(printf '%s' "$tgt" | tr '\t\n' '  ')"; id="$(printf '%s' "$id" | tr '\t\n' '  ')"; t="$(printf '%s' "$t" | tr '\t\n' '  ')"; b="$(cat | tr '\t\n' '  ')"; __bsc_coord_log "assign	$tgt	$b	$id	$t"; }
bsc-brief() { tgt="$1"; [ $# -gt 0 ] && shift; ref=""; while [ $# -gt 0 ]; do case "$1" in --ref) ref="${2-}"; shift 2 2>/dev/null || shift ;; *) shift ;; esac; done; tgt="$(printf '%s' "$tgt" | tr '\t\n' '  ')"; ref="$(printf '%s' "$ref" | tr '\t\n' '  ')"; b="$(cat | tr '\t\n' '  ')"; __bsc_coord_log "brief	$tgt	$b	$ref"; }
# Studio network (#2940): the app-owned studio sessions (planner/designer/librarian) commission
# artifacts from each other over the coord wire. `bsc-commission <target> [--ref X]` (spec on stdin)
# mirrors bsc-brief — target is "designer"|"librarian"; the pump routes it to that studio session.
# `bsc-deliver <commissionId> <artifactId>` reports the authored artifact's id back so the pump
# surfaces it to the requester. printf-joined (not literal tabs) so a spec containing `%` is safe.
bsc-commission() { tgt="$1"; [ $# -gt 0 ] && shift; ref=""; while [ $# -gt 0 ]; do case "$1" in --ref) ref="${2-}"; shift 2 2>/dev/null || shift ;; *) shift ;; esac; done; tgt="$(printf '%s' "$tgt" | tr '\t\n' '  ')"; ref="$(printf '%s' "$ref" | tr '\t\n' '  ')"; b="$(cat | tr '\t\n' '  ')"; __bsc_coord_log "$(printf 'commission\t%s\t%s\t%s' "$tgt" "$b" "$ref")"; }
bsc-deliver() { cid="$(printf '%s' "${1-}" | tr '\t\n' '  ')"; aid="$(printf '%s' "${2-}" | tr '\t\n' '  ')"; __bsc_coord deliver "$cid" "$aid"; }
bsc-fork() { j="$(cat)"; d="$(printf '%s' "$j" | __bsc_jstr 'description' | tr '	
' '  ' | cut -c1-160)"; st="$(printf '%s' "$j" | __bsc_jstr 'subagent_type' | tr '	
' '  ' | cut -c1-40)"; [ -z "$d" ] && d="(no description)"; __bsc_coord fork "$d" "$st"; return 0; }
