#!/bin/sh
# The hook client for a platform without a built bazhen-hook: the same contract as
# apps/hook/src/main.rs, several times slower. Outside a Bazhen agent, or on any failure, it exits
# 0 with no output, so the harness carries on as it would without Bazhen.

[ -n "$BAZHEN_AGENT_ID" ] && [ -n "$BAZHEN_SOCKET" ] && [ -n "$1" ] || exit 0
case "$BAZHEN_AGENT_ID$1" in *[!A-Za-z0-9_-]*) exit 0 ;; esac

REPLY_TYPE=application/vnd.bazhen.hook-reply
MAX_BODY=1048576
dir=$(mktemp -d) || exit 0
trap 'rm -rf "$dir"' EXIT
trap 'exit 0' HUP INT TERM

cat >"$dir/payload" || exit 0
{
  printf '{"payload":'
  if grep -q '[^[:space:]]' "$dir/payload"; then cat "$dir/payload"; else printf null; fi
  printf ',"protocolVersion":"1.0","agentId":"%s","event":"%s","pid":%d,"ppid":%d}' \
    "$BAZHEN_AGENT_ID" "$1" "$$" "$PPID"
} >"$dir/request" || exit 0

post() { # path, request file, seconds (curl reads 0 as no limit at all)
  [ "$3" -ge 1 ] || set -- "$1" "$2" 1
  curl -sS --unix-socket "$BAZHEN_SOCKET" --max-time "$3" -H 'Content-Type: application/json' -H 'Expect:' \
    --data-binary "@$2" -D "$dir/head" -o "$dir/body" "http://localhost$1" 2>/dev/null
}

# A waiter retries until its deadline when the daemon can't be reached or drops the request, as
# it does across a restart; any other hook gives up at once.
if [ "$1" = wait ]; then
  deadline=$(($(date +%s) + 82800))
  until post /v1/hooks "$dir/request" $((deadline - $(date +%s))); do
    [ "$(date +%s)" -lt $((deadline - 1)) ] || exit 0
    sleep 1
  done
else
  post /v1/hooks "$dir/request" 600 || exit 0
fi

# One pass over the head: the status, then each header as a lower-cased name and its value.
status='' length='' type='' chunked='' exit_code='' offered='' stdout_bytes=''
# A repeated header is as bad as a missing one; a status line resets them, after a 100 Continue.
seen=' '
while IFS=' ' read -r name value; do
  case "$name" in
    '') continue ;;
    http/*) seen=' ' ;;
    *) case "$seen" in *" $name "*) exit 0 ;; esac; seen="$seen$name " ;;
  esac
  case "$name" in
    http/*) status=$value ;;
    content-length:) length=$value ;;
    content-type:) type=$value ;;
    transfer-encoding:) chunked=$value ;;
    bazhen-exit-code:) exit_code=$value ;;
    bazhen-offered:) offered=$value ;;
    bazhen-stdout-bytes:) stdout_bytes=$value ;;
  esac
done <<EOF
$(awk '{ sub(/\r$/, ""); i = index($0, ":"); if (i) { v = substr($0, i + 1); sub(/^[ \t]+/, "", v); print tolower(substr($0, 1, i)) " " v } else print tolower($1) " " $2 }' "$dir/head")
EOF

number() { case "$1" in '' | *[!0-9]*) return 1 ;; esac; }
[ "$status" = 200 ] && [ "$type" = "$REPLY_TYPE" ] && [ -z "$chunked" ] || exit 0
number "$length" && number "$stdout_bytes" && number "$exit_code" || exit 0
[ "$length" -le "$MAX_BODY" ] && [ "$(wc -c <"$dir/body")" -eq "$length" ] &&
  [ "$stdout_bytes" -le "$length" ] && [ "$exit_code" -le 255 ] || exit 0
case "$offered" in *[!A-Za-z0-9_,-]* | ,* | *, | *,,*) exit 0 ;; esac

# BSD head refuses a count of 0.
[ "$stdout_bytes" -eq 0 ] || head -c "$stdout_bytes" "$dir/body" || exit 0
[ "$stdout_bytes" -eq "$length" ] || tail -c "+$((stdout_bytes + 1))" "$dir/body" >&2
if [ -n "$offered" ]; then
  ids=$(printf %s "$offered" | sed 's/,/","/g')
  printf '{"agentId":"%s","offered":["%s"]}' "$BAZHEN_AGENT_ID" "$ids" >"$dir/ack"
  post /v1/hooks/ack "$dir/ack" 5
fi
exit "$exit_code"
