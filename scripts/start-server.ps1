$ErrorActionPreference = "Stop"

$RootDir = Split-Path -Parent $PSScriptRoot
$EnvFileName = if ($env:ENV_FILE_NAME) { $env:ENV_FILE_NAME } else { ".env.sqlite" }

Write-Host "Starting server with $EnvFileName ..."
Set-Location (Join-Path $RootDir "team-wiki-server")
$env:ENV_FILE = $EnvFileName
npm run start
