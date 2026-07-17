$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Assert-True([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}

$PluginRoot = Split-Path -Parent $PSScriptRoot
$InvokeScript = Join-Path $PluginRoot 'skills/cross-harness-review/scripts/invoke.ps1'
$FixtureSource = Join-Path $PSScriptRoot 'fixtures/fake-cli/fake-reviewer.cs'
$Work = Join-Path $PluginRoot ('.phase2-test-' + [guid]::NewGuid().ToString('N'))
$TempRoot = Join-Path $Work 'temp'
$FakeExe = Join-Path $Work 'fake-reviewer.exe'
$environmentNames = @(
    'TEMP', 'TMP', 'PATH', 'LOCALAPPDATA', 'APPDATA', 'CROSS_HARNESS_CLAUDE', 'CROSS_HARNESS_CODEX',
    'CROSS_HARNESS_WSL_DISTRO', 'CROSS_HARNESS_TIMEOUT_SECS',
    'CROSS_HARNESS_MAX_INPUT_BYTES', 'CROSS_HARNESS_DEBUG', 'FAKE_CLI_VERSION',
    'FAKE_CLI_MODE', 'FAKE_CLI_REVIEWER', 'FAKE_CLI_TASK',
    'FAKE_CLI_ARGS_FILE', 'FAKE_CLI_STDIN_FILE', 'FAKE_WSL_DISTRO'
)
$savedEnvironment = @{}
foreach ($name in $environmentNames) { $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name) }

function Invoke-JsonBridge([string[]]$BridgeArguments) {
    $output = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $InvokeScript @BridgeArguments
    Assert-True ($LASTEXITCODE -eq 0) "Bridge exited with $LASTEXITCODE."
    ($output -join "`n") | ConvertFrom-Json
}

function Ensure-GitTestRepo {
    $repo = Join-Path $Work 'git-repo'
    if (Test-Path -LiteralPath $repo -PathType Container) { return $repo }
    New-Item -ItemType Directory -Path $repo -Force | Out-Null
    $previous = Get-Location
    $previousPath = $env:PATH
    try {
        # Tests intentionally narrow PATH for fake CLIs; restore the host PATH for git setup.
        if ($savedEnvironment.PATH) { $env:PATH = $savedEnvironment.PATH }
        $git = Get-Command git -ErrorAction Stop
        Set-Location -LiteralPath $repo
        & $git.Source init | Out-Null
        Assert-True ($LASTEXITCODE -eq 0) 'git init failed for the test repository.'
        & $git.Source config user.email 'cross-harness-tests@example.com' | Out-Null
        & $git.Source config user.name 'cross-harness-tests' | Out-Null
        Set-Content -LiteralPath (Join-Path $repo 'README.md') -Value 'fixture' -Encoding utf8
        & $git.Source add README.md | Out-Null
        & $git.Source -c commit.gpgsign=false commit -m 'init' | Out-Null
        Assert-True ($LASTEXITCODE -eq 0) 'git commit failed for the test repository.'
    } finally {
        $env:PATH = $previousPath
        Set-Location $previous
    }
    $repo
}

function Invoke-FakeRun([string]$Mode, [string]$Reviewer = 'codex', [string]$Task = 'code') {
    $env:FAKE_CLI_MODE = $Mode
    $env:FAKE_CLI_REVIEWER = $Reviewer
    $env:FAKE_CLI_TASK = $Task
    $overrideName = if ($Reviewer -eq 'codex') { 'CROSS_HARNESS_CODEX' } else { 'CROSS_HARNESS_CLAUDE' }
    [Environment]::SetEnvironmentVariable($overrideName, $FakeExe)
    $repo = Ensure-GitTestRepo
    if ($Task -eq 'plan') {
        Invoke-JsonBridge @('run', '--reviewer', $Reviewer, '--task', $Task, '--repo', $repo,
            '--input-file', (Join-Path $Work 'plan.md'), '--timeout-secs', '2', '--json')
    } else {
        Invoke-JsonBridge @('run', '--reviewer', $Reviewer, '--task', $Task, '--repo', $repo,
            '--scope', 'uncommitted', '--timeout-secs', '2', '--json')
    }
}

try {
    New-Item -ItemType Directory -Path $Work, $TempRoot -Force | Out-Null
    $compiler = "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
    Assert-True (Test-Path -LiteralPath $compiler -PathType Leaf) 'C# compiler fixture dependency is missing.'
    & $compiler /nologo /target:exe "/out:$FakeExe" $FixtureSource
    Assert-True ($LASTEXITCODE -eq 0) 'Fake reviewer failed to compile.'

    $env:TEMP = $TempRoot
    $env:TMP = $TempRoot
    $env:CROSS_HARNESS_CLAUDE = Join-Path $Work 'missing-claude.exe'
    $env:CROSS_HARNESS_WSL_DISTRO = 'cross-harness-missing-distro'
    foreach ($name in @('path-bad', 'path-old', 'path-new')) {
        $directory = Join-Path $Work $name
        New-Item -ItemType Directory -Path $directory | Out-Null
        Copy-Item -LiteralPath $FakeExe -Destination (Join-Path $directory 'codex.exe')
    }
    $wslBin = Join-Path $Work 'wsl-bin'
    New-Item -ItemType Directory -Path $wslBin | Out-Null
    Copy-Item -LiteralPath $FakeExe -Destination (Join-Path $wslBin 'wsl.exe')
    $env:FAKE_CLI_MODE = $null
    $env:CROSS_HARNESS_CODEX = $null
    $fixturePath = ((@('path-bad', 'path-old', 'path-new') | ForEach-Object { Join-Path $Work $_ }) -join ';') + ';' + $savedEnvironment.PATH
    $env:PATH = $fixturePath
    $probe = Invoke-JsonBridge @('probe', '--json')
    $codex = @($probe | Where-Object kind -eq 'codex')[0]
    Assert-True $codex.available 'Codex PATH candidates should be available.'
    Assert-True ($codex.version -eq '10.1.0') 'Numeric semver selection did not choose 10.1.0 over 2.9.0.'
    Assert-True ($codex.program -like '*path-new*codex.exe') 'Selected invocation did not preserve the winning executable.'

    $env:CROSS_HARNESS_CODEX = Join-Path $Work 'missing-codex.exe'
    $badOverride = Invoke-JsonBridge @('probe', '--json')
    $badCodex = @($badOverride | Where-Object kind -eq 'codex')[0]
    Assert-True (-not $badCodex.available) 'A broken explicit override must fail closed.'
    Assert-True ($badCodex.source -eq 'explicit-override') 'A broken override silently fell back to another candidate.'

    $env:CROSS_HARNESS_CODEX = $null
    $env:CROSS_HARNESS_WSL_DISTRO = 'fake-distro'
    $env:FAKE_WSL_DISTRO = 'fake-distro'
    $env:LOCALAPPDATA = $null
    $env:APPDATA = $null
    $env:PATH = $wslBin + ';' + $PSHOME + ';' + $env:SystemRoot + '\System32;' + $env:SystemRoot
    $wslProbe = Invoke-JsonBridge @('probe', '--json')
    $wslCodex = @($wslProbe | Where-Object kind -eq 'codex')[0]
    Assert-True ($wslCodex.available -and $wslCodex.runtime -eq 'wsl') 'Fake WSL Codex was not selected.'
    Assert-True ($wslCodex.distro -eq 'fake-distro') 'Detected WSL distribution was not retained.'
    $env:FAKE_CLI_REVIEWER = 'codex'
    $env:FAKE_CLI_TASK = 'code'
    $env:FAKE_CLI_MODE = 'success'
    $env:FAKE_CLI_ARGS_FILE = Join-Path $Work 'wsl-args.txt'
    $wslRepo = Ensure-GitTestRepo
    $wslRun = Invoke-JsonBridge @('run', '--reviewer', 'codex', '--task', 'code', '--repo', $wslRepo,
        '--scope', 'uncommitted', '--timeout-secs', '2', '--json')
    Assert-True ($wslRun.status -eq 'success') 'Fake WSL Codex run failed.'
    $wslArgs = Get-Content -LiteralPath $env:FAKE_CLI_ARGS_FILE
    $repoIndex = [array]::IndexOf($wslArgs, '-C')
    $schemaIndex = [array]::IndexOf($wslArgs, '--output-schema')
    $outputIndex = [array]::IndexOf($wslArgs, '-o')
    Assert-True ($repoIndex -ge 0 -and $wslArgs[$repoIndex + 1] -like '/mnt/*') 'WSL repo path did not use wslpath.'
    Assert-True ($schemaIndex -ge 0 -and $wslArgs[$schemaIndex + 1] -like '/mnt/*') 'WSL schema path did not use wslpath.'
    Assert-True ($outputIndex -ge 0 -and $wslArgs[$outputIndex + 1] -like '/mnt/*') 'WSL output path did not use wslpath.'

    $env:LOCALAPPDATA = $savedEnvironment.LOCALAPPDATA
    $env:APPDATA = $savedEnvironment.APPDATA
    $env:PATH = $fixturePath
    $env:CROSS_HARNESS_WSL_DISTRO = 'cross-harness-missing-distro'
    $env:FAKE_WSL_DISTRO = $null

    [System.IO.File]::WriteAllText((Join-Path $Work 'plan.md'), 'PLAN_SECRET_SENT_ONLY_ON_STDIN')
    $env:FAKE_CLI_ARGS_FILE = Join-Path $Work 'args.txt'
    $env:FAKE_CLI_STDIN_FILE = Join-Path $Work 'stdin.txt'
    $success = Invoke-FakeRun success
    Assert-True ($success.status -eq 'success') 'Fake Codex success was not preserved.'
    Assert-True ($null -ne $success.diagnostics.scope) 'Scope diagnostics were not attached.'
    Assert-True ($success.diagnostics.scope.mode -eq 'uncommitted') 'Scope diagnostics mode was wrong.'
    $recordedArgs = Get-Content -LiteralPath $env:FAKE_CLI_ARGS_FILE
    Assert-True ([array]::IndexOf($recordedArgs, '-C') -lt [array]::IndexOf($recordedArgs, '-o')) 'Codex repo selection must precede final-output selection.'
    Assert-True (-not ($recordedArgs -contains 'review')) 'Scoped Codex reviews must use generic exec because the review subcommand rejects a custom prompt with scope flags.'
    Assert-True ($recordedArgs[-1] -eq '-') 'Codex prompt sentinel must be the last argument.'
    Assert-True (-not (($recordedArgs -join ' ') -match 'PLAN_SECRET')) 'Prompt content leaked into argv.'
    $stdinBody = Get-Content -Raw -LiteralPath $env:FAKE_CLI_STDIN_FILE
    Assert-True ($stdinBody -match 'staged, unstaged, and untracked') 'Uncommitted scope was not carried in the stdin prompt.'
    Assert-True ($stdinBody -match 'HARD SCOPE BOUNDARY') 'Hard scope boundary was not injected into the stdin prompt.'

    $oos = Invoke-FakeRun 'out-of-scope-finding'
    Assert-True ($oos.status -eq 'success') 'Out-of-scope fixture run failed.'
    Assert-True (@($oos.findings).Count -ge 1) 'Out-of-scope fixture produced no findings.'
    Assert-True (@($oos.findings)[0].verification -eq 'out_of_scope') 'Host scope gate did not mark out-of-scope findings.'
    Assert-True ($oos.diagnostics.scope.outOfScopeCount -ge 1) 'Scope diagnostics did not count out-of-scope findings.'

    Assert-True ((Invoke-FakeRun quota).status -eq 'quota_exhausted') 'Quota failure classification failed.'
    Assert-True ((Invoke-FakeRun auth).status -eq 'authentication_failed') 'Authentication failure classification failed.'
    Assert-True ((Invoke-FakeRun permission).status -eq 'permission_failed') 'Permission failure classification failed.'
    Assert-True ((Invoke-FakeRun process-fail).status -eq 'process_failed') 'Process failure classification failed.'
    Assert-True ((Invoke-FakeRun invalid-output).status -eq 'invalid_output') 'Invalid output classification failed.'
    Assert-True ((Invoke-FakeRun missing-output).status -eq 'invalid_output') 'Missing Codex output classification failed.'
    $oversized = Invoke-FakeRun oversized-stderr
    Assert-True ($oversized.status -eq 'success' -and $oversized.diagnostics.stderrTruncated) 'stderr truncation was not reported.'
    Assert-True ((Invoke-FakeRun timeout).status -eq 'timeout') 'Timeout classification failed.'
    Assert-True ($null -eq (Get-Process fake-reviewer -ErrorAction SilentlyContinue)) 'Timed-out fake reviewer was left running.'

    $claude = Invoke-FakeRun success claude plan
    Assert-True ($claude.status -eq 'success') 'Claude outer JSON/result parsing failed.'
    Assert-True ((Get-Content -Raw -LiteralPath $env:FAKE_CLI_STDIN_FILE) -match 'PLAN_SECRET_SENT_ONLY_ON_STDIN') 'Plan was not delivered through stdin.'
    Assert-True (@(Get-ChildItem -LiteralPath $TempRoot -Directory -Filter 'cross-harness-review-*').Count -eq 0) 'Invocation temp directories were not cleaned.'

    Write-Output 'Phase 2 PowerShell probe and runner matrix passed.'
} finally {
    foreach ($name in $environmentNames) { [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name]) }
    if (Test-Path -LiteralPath $Work -PathType Container) {
        $resolved = (Resolve-Path -LiteralPath $Work).Path
        if ((Split-Path -Leaf $resolved) -notmatch '^\.phase2-test-[0-9a-f]{32}$') { throw 'Refusing unsafe test cleanup.' }
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
}
