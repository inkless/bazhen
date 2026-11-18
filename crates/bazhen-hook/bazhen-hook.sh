#!/bin/sh
# The hook client for a platform without a built bazhen-hook: the same contract as
# crates/bazhen-hook/src/main.rs, several times slower. Outside a Bazhen agent, or on any failure, it exits
# 0 with no output, so the harness carries on as it would without Bazhen.

# Writes the header that proves which agent this is into the file $1, from the agent's token
# file, or leaves it empty for a file that holds no token. The token goes to curl in a file: on
# its command line every user of the machine could read it.
agent_header() {
  : >"$1" || return 1
  token=$(cat "$BAZHEN_AGENT_AUTH_FILE" 2>/dev/null) || return 0
  case "$token" in *[!A-Za-z0-9_-]*) return 0 ;; esac
  [ "${#token}" -eq 43 ] || return 0
  printf 'Bazhen-Agent-Token: %s\n' "$token" >"$1"
}

# The status line: run the user's own command (the rest of the arguments) on the same input,
# its output passed through, and hand that input to the daemon in passing (see statusline.rs).
if [ "$1" = statusline-wrap ]; then
  shift
  input=$(mktemp) || exit 0
  auth=$(mktemp) || { rm -f "$input"; exit 0; }
  trap 'rm -f "$input" "$auth"' EXIT
  cat >"$input"
  if [ -n "$BAZHEN_AGENT_ID" ] && [ -n "$BAZHEN_SOCKET" ] && agent_header "$auth"; then
    case "$BAZHEN_AGENT_ID" in *[!A-Za-z0-9_-]*) ;; *)
      {
        printf '{"payload":'
        if grep -q '[^[:space:]]' "$input"; then cat "$input"; else printf null; fi
        printf ',"protocolVersion":"1.0","agentId":"%s","event":"statusline","pid":%d,"ppid":%d}' \
          "$BAZHEN_AGENT_ID" "$$" "$PPID"
      } | curl -sS --unix-socket "$BAZHEN_SOCKET" --max-time 0.2 -H 'Content-Type: application/json' \
        -H 'Expect:' -H "@$auth" --data-binary @- -o /dev/null http://localhost/v1/hooks \
        2>/dev/null &
      ;;
    esac
  fi
  code=0
  [ "$#" -gt 0 ] && { "$@" <"$input"; code=$?; }
  wait
  exit "$code"
fi

[ -n "$BAZHEN_AGENT_ID" ] && [ -n "$BAZHEN_SOCKET" ] && [ -n "$1" ] || exit 0
case "$BAZHEN_AGENT_ID$1" in *[!A-Za-z0-9_-]*) exit 0 ;; esac

REPLY_TYPE=application/vnd.bazhen.hook-reply
MAX_BODY=1048576
dir=$(mktemp -d) || exit 0
trap 'rm -rf "$dir"' EXIT
trap 'exit 0' HUP INT TERM

cat >"$dir/payload" || exit 0
agent_header "$dir/auth" || exit 0
{
  printf '{"payload":'
  if grep -q '[^[:space:]]' "$dir/payload"; then cat "$dir/payload"; else printf null; fi
  printf ',"protocolVersion":"1.0","agentId":"%s","event":"%s","pid":%d,"ppid":%d}' \
    "$BAZHEN_AGENT_ID" "$1" "$$" "$PPID"
} >"$dir/request" || exit 0

post() { # path, request file, seconds (curl reads 0 as no limit at all)
  [ "$3" -ge 1 ] || set -- "$1" "$2" 1
  rm -f "$dir/head"
  curl -sS --unix-socket "$BAZHEN_SOCKET" --max-time "$3" --max-filesize "$MAX_BODY" \
    -H 'Content-Type: application/json' -H 'Expect:' -H "@$dir/auth" \
    --data-binary "@$2" -D "$dir/head" -o "$dir/body" "http://localhost$1" 2>/dev/null
}

# A whole head came back that the reply is refused for whatever follows it, so a transfer that
# then failed, as by a reset, is no reason to try again. The first head is the reply's own:
# `Expect:` goes empty, so no 100 Continue comes before it.
refused() {
  awk -v max="$MAX_BODY" '
    { sub(/\r$/, "") }
    $0 == "" { whole = 1; exit }
    { i = index($0, ":"); v = substr($0, i + 1); gsub(/^[ \t]+|[ \t]+$/, "", v) }
    i && tolower(substr($0, 1, i)) == "content-length:" { n++; length_ = v }
    END { exit !(whole && !(n == 1 && length_ ~ /^[0-9]+$/ && length_ + 0 <= max)) }
  ' "$dir/head" 2>/dev/null
}

# The daemon's 503: it couldn't read the caller in time.
late() {
  head -n 1 "$dir/head" 2>/dev/null | grep -q '^HTTP/[0-9.]* 503 '
}

# A waiter retries until its deadline when the daemon can't be reached, drops the request, or cuts
# a reply short, as it does across a restart; never on a reply it would refuse. On a 503 it asks
# again 1, 2, 4, 8 and 16 seconds later, then gives up, as the binary does. Any other hook gives
# up at once.
if [ "$1" = wait ]; then
  deadline=$(($(date +%s) + 82800))
  pause=1
  while :; do
    if post /v1/hooks "$dir/request" $((deadline - $(date +%s))); then
      late || break
      [ "$pause" -le 16 ] || exit 0
      wait_for=$pause
      pause=$((pause * 2))
    else
      # curl's own refusals of the reply: 8, a Content-Length that isn't one; 63, a body over
      # MAX_BODY, or a length too large to read.
      case $? in 8 | 63) exit 0 ;; esac
      refused && exit 0
      wait_for=1
    fi
    [ "$(date +%s)" -lt $((deadline - 1)) ] || exit 0
    sleep "$wait_for"
  done
else
  # PostToolUse runs on every tool call, and a fold it misses waits for a wake.
  [ "$1" = PostToolUse ] && limit=2 || limit=600
  post /v1/hooks "$dir/request" "$limit" || exit 0
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
