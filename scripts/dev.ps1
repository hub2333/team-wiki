$ErrorActionPreference = "Stop"

$RootDir = Split-Path -Parent $PSScriptRoot
$EnvFileName = if ($env:ENV_FILE_NAME) { $env:ENV_FILE_NAME } else { ".env.sqlite" }
$ServerPort = 3100
$UiPort = 3202

function Stop-PortProcess {
  param(
    [int]$Port,
    [string]$Name
  )

  $conns = Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue
  if (-not $conns) {
    return
  }

  $pids = $conns | Select-Object -ExpandProperty OwningProcess -Unique
  foreach ($processId in $pids) {
    try {
      Write-Host "Stopping $Name on port $Port (PID: $processId) ..."
      Stop-Process -Id $processId -Force -ErrorAction Stop
    } catch {
    }
  }
}

Stop-PortProcess -Port $ServerPort -Name "server"
Stop-PortProcess -Port $UiPort -Name "ui"

$serverCommand = "Set-Location '$($RootDir.Replace("'", "''"))\team-wiki-server'; `$env:ENV_FILE='$EnvFileName'; npm run dev"
$uiCommand = "Set-Location '$($RootDir.Replace("'", "''"))\team-wiki-react-ui'; npm run dev"

Write-Host "========================================="
Write-Host "  Starting server (watch) ..."
Write-Host "========================================="
$serverProcess = Start-Process powershell -WindowStyle Hidden -ArgumentList @("-NoProfile", "-Command", $serverCommand) -PassThru

Write-Host ""
Write-Host "========================================="
Write-Host "  Starting ui (watch) ..."
Write-Host "========================================="
$uiProcess = Start-Process powershell -WindowStyle Hidden -ArgumentList @("-NoProfile", "-Command", $uiCommand) -PassThru

Write-Host ""
Write-Host "server (watch) -> http://localhost:$ServerPort"
Write-Host "ui     (watch) -> http://localhost:$UiPort"
Write-Host "env            -> $EnvFileName"
Write-Host "server PID     -> $($serverProcess.Id)"
Write-Host "ui PID         -> $($uiProcess.Id)"
