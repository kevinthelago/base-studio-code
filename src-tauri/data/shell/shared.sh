__bsc_jstr() { grep -oE "\"($1)\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" | head -1 | sed -E 's/.*"([^"]*)"$/\1/'; }
__bsc_now_ms() { n="$(date +%s%3N 2>/dev/null)"; case "$n" in ''|*[!0-9]*) n="$(( $(date -u +%s) * 1000 ))" ;; esac; printf '%s' "$n"; }
__bsc_logline() { f="$1"; fmt="$2"; shift 2; mkdir -p "$(dirname "$f")" 2>/dev/null; printf "$fmt" "$@" >> "$f"; }
