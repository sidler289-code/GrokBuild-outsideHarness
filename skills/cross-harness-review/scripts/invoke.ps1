[CmdletBinding()]
param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$ForwardedArgs
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$pluginRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..\..')).Path
$entrypoint = Join-Path $pluginRoot 'bin\cross-harness-review.cjs'
$node = @(Get-Command node.exe, node -ErrorAction SilentlyContinue | Select-Object -First 1)[0]

if ($null -eq $node) {
    [Console]::Error.WriteLine('cross-harness-review requires Node.js >=20 on PATH.')
    exit 127
}
if (-not (Test-Path -LiteralPath $entrypoint -PathType Leaf)) {
    [Console]::Error.WriteLine("cross-harness-review Node entrypoint is unavailable: $entrypoint")
    exit 127
}

& $node.Source $entrypoint @ForwardedArgs
exit $LASTEXITCODE
