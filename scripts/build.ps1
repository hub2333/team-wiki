$ErrorActionPreference = "Stop"

$RootDir = Split-Path -Parent $PSScriptRoot

Write-Host "========================================="
Write-Host "  Building server..."
Write-Host "========================================="
Set-Location (Join-Path $RootDir "team-wiki-server")
npm run build
Write-Host "server build complete"

Write-Host ""
Write-Host "========================================="
Write-Host "  Building ui..."
Write-Host "========================================="
Set-Location (Join-Path $RootDir "team-wiki-react-ui")
npm run build
Write-Host "ui build complete"

Write-Host ""
Write-Host "All builds complete"
