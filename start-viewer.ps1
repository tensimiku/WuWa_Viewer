param(
  [string]$GameDir = "",
  [string]$KeysPath = "",
  [string]$CacheDir = "",
  [int]$ApiPort = 5180,
  [int]$UiPort = 5173,
  [switch]$NoBuild
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

# Load optional .env at repository root without overwriting existing env vars
$dotEnvPath = Join-Path $root ".env"
if (Test-Path $dotEnvPath) {
  foreach ($rawLine in Get-Content $dotEnvPath) {
    $line = $rawLine.Trim()
    if (-not $line -or $line.StartsWith("#")) { continue }
    if ($line.StartsWith("export ")) { $line = $line.Substring(7).TrimStart() }
    $eq = $line.IndexOf('=')
    if ($eq -le 0) { continue }
    $key = $line.Substring(0, $eq).Trim()
    $val = $line.Substring($eq + 1).Trim()
    if (($val.StartsWith('"') -and $val.EndsWith('"') -and $val.Length -ge 2) -or
        ($val.StartsWith("'") -and $val.EndsWith("'") -and $val.Length -ge 2)) {
      $val = $val.Substring(1, $val.Length - 2)
    }
    if (-not [Environment]::GetEnvironmentVariable($key)) {
      [Environment]::SetEnvironmentVariable($key, $val, "Process")
    }
  }
}

if ($GameDir)  { $env:WUWA_GAME_DIR  = $GameDir }
if ($KeysPath) { $env:WUWA_KEYS_PATH = $KeysPath }
if ($CacheDir) { $env:WUWA_CACHE_DIR = $CacheDir }

if (-not $env:WUWA_API_URL)    { $env:WUWA_API_URL    = "http://localhost:$ApiPort" }
if (-not $env:VITE_API_TARGET) { $env:VITE_API_TARGET = $env:WUWA_API_URL }
if (-not $env:VITE_PORT)       { $env:VITE_PORT       = "$UiPort" }

$cueProj = Join-Path $root "CUE4Parse\CUE4Parse\CUE4Parse.csproj"
if (-not (Test-Path $cueProj)) {
  Write-Error "Missing CUE4Parse submodule at '$root\CUE4Parse'. Run 'git submodule update --init --recursive' first."
}

$nodeModules = Join-Path $root "frontend\node_modules"
if (-not (Test-Path $nodeModules)) {
  Write-Error "Missing frontend/node_modules. Run 'npm install' inside '$root\frontend' first."
}

# Check whether GameDir is configured via env or appsettings*.json
$hasGameDir = [bool]$env:WUWA_GAME_DIR
if (-not $hasGameDir) {
  foreach ($cfgName in @("appsettings.Local.json", "appsettings.json")) {
    $cfgPath = Join-Path $root "WuWaViewer.Server\$cfgName"
    if (Test-Path $cfgPath) {
      try {
        $json = Get-Content $cfgPath -Raw | ConvertFrom-Json
        if ($json.WuWaViewer -and $json.WuWaViewer.GameDir) {
          $hasGameDir = $true
          break
        }
      } catch {}
    }
  }
}

if (-not $hasGameDir) {
  Write-Error "Game directory is not configured. Copy .env.example to .env (and set WUWA_GAME_DIR), create WuWaViewer.Server/appsettings.Local.json from appsettings.Local.example.json, or pass -GameDir '<path>'."
}

$dotnetArgs = if ($NoBuild) { "run --no-build" } else { "run" }
Write-Host "Starting WuWaViewer Backend ($($env:WUWA_API_URL))..." -ForegroundColor Cyan
$backend = Start-Process -FilePath "dotnet" `
  -ArgumentList $dotnetArgs `
  -WorkingDirectory (Join-Path $root "WuWaViewer.Server") `
  -PassThru

Write-Host "Starting WuWaViewer Frontend (http://localhost:$UiPort)..." -ForegroundColor Cyan
$frontend = Start-Process -FilePath "cmd.exe" `
  -ArgumentList "/c npm run dev -- --port $UiPort --strictPort" `
  -WorkingDirectory (Join-Path $root "frontend") `
  -PassThru

Write-Host ""
Write-Host "WuWaViewer is running:" -ForegroundColor Green
Write-Host "  UI:  http://localhost:$UiPort"
Write-Host "  API: $($env:WUWA_API_URL)/api/health"
Write-Host "Press Enter in this window to stop both servers." -ForegroundColor Yellow
Read-Host | Out-Null

if ($frontend -and -not $frontend.HasExited) { Stop-Process -Id $frontend.Id -Force -ErrorAction SilentlyContinue }
if ($backend -and -not $backend.HasExited) { Stop-Process -Id $backend.Id -Force -ErrorAction SilentlyContinue }
