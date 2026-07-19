#!/usr/bin/env sh
set -eu

PATH="${PATH:+$PATH:}/usr/bin"
script_path=$0
if command -v cygpath >/dev/null 2>&1; then
  script_path=$(cygpath -u "$0")
fi
case $script_path in
  */*) script_dir=${script_path%/*} ;;
  *) script_dir=. ;;
esac
script_dir=$(CDPATH= cd -- "$script_dir" && pwd)
plugin_root=$(CDPATH= cd -- "$script_dir/../../.." && pwd)
entrypoint="$plugin_root/bin/cross-harness-review.cjs"

if ! command -v node >/dev/null 2>&1; then
  printf '%s\n' 'cross-harness-review requires Node.js >=20 on PATH.' >&2
  exit 127
fi
if [ ! -f "$entrypoint" ]; then
  printf '%s\n' "cross-harness-review Node entrypoint is unavailable: $entrypoint" >&2
  exit 127
fi

exec node "$entrypoint" "$@"
