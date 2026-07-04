bsc-done() { cat >/dev/null 2>&1; l="${BSC_DONE_LOG:-}"; [ -z "$l" ] && return 0; ts="$(__bsc_now_ms)"; __bsc_logline "$l" '%s\t%s\n' "$ts" "${BSC_AUDIT_PANE:-?}"; return 0; }
