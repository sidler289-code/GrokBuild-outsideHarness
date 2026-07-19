$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$pluginRoot = Split-Path -Parent $PSScriptRoot
$nodeEntrypoint = Join-Path $pluginRoot 'bin\cross-harness-review.cjs'
$shim = Join-Path $pluginRoot 'skills\cross-harness-review\scripts\invoke.ps1'

$direct = & node.exe $nodeEntrypoint --help
if ($LASTEXITCODE -ne 0) { throw "Direct Node entrypoint exited with $LASTEXITCODE." }
$throughShim = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $shim --help
if ($LASTEXITCODE -ne 0) { throw "PowerShell shim exited with $LASTEXITCODE." }

if (($direct -join "`n") -ne ($throughShim -join "`n")) {
    throw 'PowerShell shim output differs from the direct Node entrypoint.'
}

Write-Output 'PR-2 PowerShell shim forwarding smoke test passed.'
