#!/usr/bin/env sh
set -eu

version=${FAKE_CLI_VERSION:-9.0.0}
mode=${FAKE_CLI_MODE:-success}
reviewer=${FAKE_CLI_REVIEWER:-codex}
task=${FAKE_CLI_TASK:-code}
for arg in "$@"; do
  if [ "$arg" = --version ]; then
    case $mode in
      version-fail) printf '%s\n' 'broken executable' >&2; exit 7;;
      version-invalid) printf '%s\n' 'version unknown'; exit 0;;
      version-timeout) sleep 8;;
    esac
    printf '%s-cli %s\n' "$reviewer" "$version"
    exit 0
  fi
done

cat >/dev/null
case $mode in
  timeout) sleep 8; exit 0;; quota) printf '%s\n' 'Quota exhausted: usage limit reached.' >&2; exit 1;;
  auth) printf '%s\n' 'Authentication failed: login required.' >&2; exit 1;;
  permission) printf '%s\n' 'Permission denied by read-only sandbox.' >&2; exit 1;;
  process-fail) printf '%s\n' 'unexpected process failure' >&2; exit 9;;
esac

output=''
previous=''
for arg in "$@"; do
  if [ "$previous" = -o ]; then output=$arg; break; fi
  previous=$arg
done
[ "$mode" != oversized-stderr ] || awk 'BEGIN { for (i=0; i<40000; i++) printf "x" }' >&2
if [ "$mode" = invalid-output ]; then payload='this is not json'
else payload="{\"schemaVersion\":1,\"task\":\"$task\",\"reviewer\":\"$reviewer\",\"status\":\"success\",\"capability\":{\"version\":\"$version\",\"runtime\":null,\"source\":\"fixture\",\"reason\":null},\"summary\":\"Fake reviewer completed.\",\"findings\":[],\"diagnostics\":{\"durationMs\":1,\"stdoutTruncated\":false,\"stderrTruncated\":false,\"rawOutput\":null}}"
fi

if [ "$reviewer" = codex ]; then
  [ "$mode" = missing-output ] || printf '%s' "$payload" > "$output"
else
  if [ "$mode" = structured-output ]; then
    printf '%s\n' '{"is_error":false,"structured_output":{"summary":"Unicode 中文 summary","findingsJson":"[]"}}'
  else
    printf '%s\n' "$payload"
  fi
fi
