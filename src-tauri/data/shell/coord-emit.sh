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
bsc-issue() { t=""; s=""; id=""; while [ $# -gt 0 ]; do case "$1" in --title) t="$2"; shift 2 ;; --suggested) s="$2"; shift 2 ;; --id) id="$2"; shift 2 ;; *) shift ;; esac; done; t="$(printf '%s' "$t" | tr '\t\n' '  ')"; s="$(printf '%s' "$s" | tr '\t\n' '  ')"; id="$(printf '%s' "$id" | tr '\t\n' '  ')"; b="$(cat | tr '\t\n' '  ')"; __bsc_coord_log "issue	$t	$b	$s	$id"; }
bsc-assign() { tgt="$1"; [ $# -gt 0 ] && shift; id=""; t=""; while [ $# -gt 0 ]; do case "$1" in --issue) id="$2"; shift 2 ;; --title) t="$2"; shift 2 ;; *) shift ;; esac; done; tgt="$(printf '%s' "$tgt" | tr '\t\n' '  ')"; id="$(printf '%s' "$id" | tr '\t\n' '  ')"; t="$(printf '%s' "$t" | tr '\t\n' '  ')"; b="$(cat | tr '\t\n' '  ')"; __bsc_coord_log "assign	$tgt	$b	$id	$t"; }
