param(
    [Parameter(Position = 0)][string]$First,
    [Parameter(Position = 1)][string]$Second,
    [Parameter(Position = 2, ValueFromRemainingArguments = $true)][string[]]$Arguments,
    [Alias('version')][switch]$VersionSwitch,
    [Alias('C')][string]$RepoPath,
    [Alias('s')][string]$Sandbox,
    [Alias('o')][string]$OutputPath,
    [switch]$Ephemeral,
    [Alias('ignore-user-config')][switch]$IgnoreUserConfig,
    [Alias('ignore-rules')][switch]$IgnoreRules,
    [Alias('skip-git-repo-check')][switch]$SkipGitRepoCheck,
    [switch]$Uncommitted,
    [string]$Base,
    [string]$Commit,
    [Alias('p')][switch]$PrintMode,
    [Alias('safe-mode')][switch]$SafeMode,
    [Alias('permission-mode')][string]$PermissionMode,
    [string]$Tools,
    [Alias('add-dir')][string]$AddDirectory,
    [Alias('no-session-persistence')][switch]$NoSessionPersistence,
    [Alias('output-format')][string]$OutputFormat
)

$ErrorActionPreference = 'Stop'
$version = if ($env:FAKE_CLI_VERSION) { $env:FAKE_CLI_VERSION } else { '9.0.0' }
$mode = if ($env:FAKE_CLI_MODE) { $env:FAKE_CLI_MODE } else { 'success' }
$reviewer = if ($env:FAKE_CLI_REVIEWER) { $env:FAKE_CLI_REVIEWER } else { 'codex' }
$task = if ($env:FAKE_CLI_TASK) { $env:FAKE_CLI_TASK } else { 'code' }

if ($VersionSwitch) {
    if ($mode -eq 'version-fail') { [Console]::Error.WriteLine('broken executable'); exit 7 }
    if ($mode -eq 'version-invalid') { Write-Output 'version unknown'; exit 0 }
    if ($mode -eq 'version-timeout') { Start-Sleep -Seconds 8 }
    Write-Output "$reviewer-cli $version"
    exit 0
}

[void][Console]::In.ReadToEnd()
switch ($mode) {
    'timeout' { Start-Sleep -Seconds 8; exit 0 }
    'quota' { [Console]::Error.WriteLine('Quota exhausted: usage limit reached.'); exit 1 }
    'auth' { [Console]::Error.WriteLine('Authentication failed: login required.'); exit 1 }
    'permission' { [Console]::Error.WriteLine('Permission denied by read-only sandbox.'); exit 1 }
    'process-fail' { [Console]::Error.WriteLine('unexpected process failure'); exit 9 }
}

if ($mode -eq 'oversized-stderr') { [Console]::Error.Write(('x' * 40000)) }
$payload = if ($mode -eq 'invalid-output') {
    'this is not json'
} else {
    [ordered]@{
        schemaVersion = 1
        task = $task
        reviewer = $reviewer
        status = 'success'
        capability = [ordered]@{ version = $version; runtime = $null; source = 'fixture'; reason = $null }
        summary = 'Fake reviewer completed.'
        findings = @()
        diagnostics = [ordered]@{ durationMs = 1; stdoutTruncated = $false; stderrTruncated = $false; rawOutput = $null }
    } | ConvertTo-Json -Depth 8 -Compress
}

if ($reviewer -eq 'codex') {
    if ($mode -ne 'missing-output') {
        [System.IO.File]::WriteAllText($outputPath, $payload, (New-Object System.Text.UTF8Encoding($false)))
    }
} else {
    [ordered]@{ is_error = $false; result = $payload } | ConvertTo-Json -Depth 8 -Compress
}
