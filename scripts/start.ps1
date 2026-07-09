$ErrorActionPreference = "Stop"

$RootDir = Split-Path -Parent $PSScriptRoot
$EnvFileName = if ($env:ENV_FILE_NAME) { $env:ENV_FILE_NAME } else { ".env.sqlite" }

$serverCommand = "Set-Location '$($RootDir.Replace("'", "''"))\team-wiki-server'; `$env:ENV_FILE='$EnvFileName'; npm run start"
$uiCommand = "Set-Location '$($RootDir.Replace("'", "''"))\team-wiki-react-ui'; npm run dev"

Write-Host "========================================="
Write-Host "  Starting server ..."
Write-Host "========================================="
$serverProcess = Start-Process powershell -WindowStyle Hidden -ArgumentList @("-NoProfile", "-Command", $serverCommand) -PassThru

Write-Host ""
Write-Host "========================================="
Write-Host "  Starting ui (vite dev) ..."
Write-Host "========================================="
$uiProcess = Start-Process powershell -WindowStyle Hidden -ArgumentList @("-NoProfile", "-Command", $uiCommand) -PassThru

Write-Host ""
Write-Host "server -> http://localhost:3100"
Write-Host "ui     -> http://localhost:3202"
Write-Host "env    -> $EnvFileName"
Write-Host "server PID -> $($serverProcess.Id)"
Write-Host "ui PID     -> $($uiProcess.Id)"
