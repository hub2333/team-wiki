$ErrorActionPreference = "Stop"

$RootDir = Split-Path -Parent $PSScriptRoot

Write-Host "Starting ui (vite dev) ..."
Set-Location (Join-Path $RootDir "team-wiki-react-ui")
npm run dev
