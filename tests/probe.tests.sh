#!/usr/bin/env sh
set -eu

test_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
plugin_root=$(CDPATH= cd -- "$test_dir/.." && pwd)
invoke_script="$plugin_root/skills/cross-harness-review/scripts/invoke.sh"
work="$plugin_root/.phase2-posix-test.$$"
mkdir -p "$work/temp" "$work/path-bad" "$work/path-old" "$work/path-new" "$work/wsl-bin"
trap 'rm -rf -- "$work"' EXIT HUP INT TERM

cp "$test_dir/fixtures/fake-cli/path-bad/codex" "$work/path-bad/codex"
cp "$test_dir/fixtures/fake-cli/path-old/codex" "$work/path-old/codex"
cp "$test_dir/fixtures/fake-cli/path-new/codex" "$work/path-new/codex"
chmod +x "$work/path-bad/codex" "$work/path-old/codex" "$work/path-new/codex"
FAKE_CSC_SOURCE=$(cygpath -w "$test_dir/fixtures/fake-cli/fake-reviewer.cs")
FAKE_CSC_OUTPUT=$(cygpath -w "$work/wsl-bin/wsl.exe")
export FAKE_CSC_SOURCE FAKE_CSC_OUTPUT
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command '$compiler = Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"; & $compiler /nologo /target:exe ("/out:" + $env:FAKE_CSC_OUTPUT) $env:FAKE_CSC_SOURCE; exit $LASTEXITCODE'
unset FAKE_CSC_SOURCE FAKE_CSC_OUTPUT
export TMPDIR="$work/temp"
export CROSS_HARNESS_CLAUDE="$work/missing-claude"
unset CROSS_HARNESS_CODEX FAKE_CLI_MODE
unset LOCALAPPDATA APPDATA
old_path=$PATH
PATH="$work/path-bad:$work/path-old:$work/path-new:/usr/bin:/bin"; export PATH

probe=$(sh "$invoke_script" probe --json)
printf '%s' "$probe" | grep -q '"kind":"codex","available":true'
printf '%s' "$probe" | grep -q '"version":"10.1.0"'
printf '%s' "$probe" | grep -q 'path-new/codex'

export CROSS_HARNESS_CODEX="$work/missing-codex"
bad=$(sh "$invoke_script" probe --json)
printf '%s' "$bad" | grep -q '"kind":"codex","available":false'
printf '%s' "$bad" | grep -q '"source":"explicit-override"'

unset CROSS_HARNESS_CODEX LOCALAPPDATA APPDATA
export CROSS_HARNESS_WSL_DISTRO=fake-distro FAKE_WSL_DISTRO=fake-distro
export FAKE_CLI_VERSION=99.0.0 FAKE_CLI_REVIEWER=codex FAKE_CLI_TASK=code FAKE_CLI_MODE=success
wsl_args_file="$work/wsl-args.txt"
FAKE_CLI_ARGS_FILE=$(cygpath -w "$wsl_args_file"); export FAKE_CLI_ARGS_FILE
PATH="$work/wsl-bin:$old_path"; export PATH
wsl_probe=$(sh "$invoke_script" probe --json)
printf '%s' "$wsl_probe" | grep -q '"runtime":"wsl"'
printf '%s' "$wsl_probe" | grep -q '"distro":"fake-distro"'
wsl_run=$(sh "$invoke_script" run --reviewer codex --task code --repo "$plugin_root" --scope uncommitted --timeout-secs 2 --json)
printf '%s' "$wsl_run" | grep -q '"status":"success"'
grep -A1 '^-C$' "$wsl_args_file" | grep -q '^/mnt/'
grep -A1 '^--output-schema$' "$wsl_args_file" | grep -q '^/mnt/'
grep -A1 '^-o$' "$wsl_args_file" | grep -q '^/mnt/'

unset CROSS_HARNESS_WSL_DISTRO FAKE_WSL_DISTRO FAKE_CLI_VERSION FAKE_CLI_ARGS_FILE
PATH=$old_path; export PATH
export CROSS_HARNESS_CODEX="$test_dir/fixtures/fake-cli/fake-reviewer.sh"
export FAKE_CLI_REVIEWER=codex FAKE_CLI_TASK=code
run_mode() {
  FAKE_CLI_MODE=$1; export FAKE_CLI_MODE
  sh "$invoke_script" run --reviewer codex --task code --repo "$plugin_root" --scope uncommitted --timeout-secs 2 --json
}

printf '%s' "$(run_mode success)" | grep -q '"status":"success"'
printf '%s' "$(run_mode quota)" | grep -q '"status":"quota_exhausted"'
printf '%s' "$(run_mode auth)" | grep -q '"status":"authentication_failed"'
printf '%s' "$(run_mode permission)" | grep -q '"status":"permission_failed"'
printf '%s' "$(run_mode process-fail)" | grep -q '"status":"process_failed"'
printf '%s' "$(run_mode invalid-output)" | grep -q '"status":"invalid_output"'
printf '%s' "$(run_mode missing-output)" | grep -q '"status":"invalid_output"'
printf '%s' "$(run_mode timeout)" | grep -q '"status":"timeout"'

FAKE_CLI_MODE=success; export FAKE_CLI_MODE
find "$work/temp" -maxdepth 1 -type d -name 'cross-harness-review.*' | grep -q . && {
  printf '%s\n' 'Temporary invocation directory leaked.' >&2; exit 1;
}

printf '%s\n' 'Phase 2 POSIX probe and runner matrix passed.'
