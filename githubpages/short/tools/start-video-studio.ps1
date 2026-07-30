param(
  [int]$Port = 8766
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
python (Join-Path $PSScriptRoot "video-studio.py") --port $Port
