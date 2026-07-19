#!/usr/bin/env sh
set -eu

case $0 in
  */*) script_dir=${0%/*} ;;
  *) script_dir=. ;;
esac
script_dir=$(CDPATH= cd -- "$script_dir" && pwd)
plugin_root=$(CDPATH= cd -- "$script_dir/.." && pwd)
node_entrypoint="$plugin_root/bin/cross-harness-review.cjs"
shim="$plugin_root/skills/cross-harness-review/scripts/invoke.sh"
PATH="${PATH:+$PATH:}/usr/bin"

direct=$(node "$node_entrypoint" --help)
through_shim=$(sh "$shim" --help)

if [ "$direct" != "$through_shim" ]; then
  printf '%s\n' 'POSIX shim output differs from the direct Node entrypoint.' >&2
  exit 1
fi

printf '%s\n' 'PR-2 POSIX shim forwarding smoke test passed.'
