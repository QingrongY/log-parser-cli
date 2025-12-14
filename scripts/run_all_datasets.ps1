param(
  [string]$OutputDir = "benchmark/results",
  [string]$DatasetsRoot = "datasets",
  [string]$NodeBin = "node",
  [string]$Cli = "dist/src/cli/main.js",
  [switch]$Build = $true
)

# Set API key here for batch runs (do not commit real secrets to VCS)
$env:AIMLAPI_API_KEY = "e784806aab8b4e1cbd35c4647b3a3d3f"

if ($Build) {
  Write-Host "Building project (npm run build)..."
  npm run build
  if ($LASTEXITCODE -ne 0) { Write-Error "npm run build failed"; exit 1 }
}

if (-not (Test-Path $Cli)) {
  Write-Error "CLI not found: $Cli (build output missing)"; exit 1
}

$datasets = Get-ChildItem -Directory $DatasetsRoot | Sort-Object Name
if ($datasets.Count -eq 0) {
  Write-Error "No datasets found under $DatasetsRoot"; exit 1
}

$total = $datasets.Count
$idx = 0
$results = @()

foreach ($d in $datasets) {
  $idx += 1
  $name = $d.Name

  $log = Get-ChildItem $d.FullName -File -Filter "*_2k.log" | Select-Object -First 1
  if (-not $log) { $log = Get-ChildItem $d.FullName -File -Filter "*.log" | Select-Object -First 1 }

  if (-not $log) { Write-Warning "[$name] skip: no log file"; continue }

  $outDir = Join-Path $OutputDir $name
  New-Item -ItemType Directory -Force -Path $outDir | Out-Null

  $logPath = $log.FullName
  $runLog = Join-Path $outDir "run.log"

  Write-Host "[${idx}/$total] dataset=$name log=$($log.Name)"
  & $NodeBin $Cli --input $logPath --output $outDir --source-hint $name
  if ($LASTEXITCODE -ne 0) {
    Write-Warning "[$name] failed (exit $LASTEXITCODE)."
    continue
  }

  $results += [pscustomobject]@{
    Dataset = $name
    Output = $outDir
    Log = $runLog
  }
}

Write-Progress -Activity "Batch log parsing" -Completed -Status "Done"
Write-Host "`nSummary:"
if ($results.Count -gt 0) {
  $results | Format-Table -AutoSize
} else {
  Write-Host "No results collected."
}

Write-Host "Outputs are under $OutputDir"
