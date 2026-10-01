param(
  [Parameter(Mandatory = $true)][string]$Spec,
  [Parameter(Mandatory = $true)][string]$Slug
)
# Pack one npm spec and extract it into .refs/npm/<slug>, so the local reference
# tree always matches the running DSH release instead of a guessed version.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$env:npm_config_cache = Join-Path $root '.npm-cache'
$tmp = Join-Path $root '.tmp-pack'
$dest = Join-Path (Join-Path $root '.refs\npm') $Slug
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

Push-Location $tmp
try {
  $raw = npm pack $Spec --json 2>&1 | Out-String
  $name = [regex]::Match($raw, '"filename"\s*:\s*"([^"]+)"').Groups[1].Value
  if ([string]::IsNullOrWhiteSpace($name)) { throw "npm pack produced no filename for $Spec : $raw" }
} finally {
  Pop-Location
}

if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
New-Item -ItemType Directory -Force -Path $dest | Out-Null
tar -xzf (Join-Path $tmp $name) -C $dest --strip-components=1
if ($LASTEXITCODE -ne 0) { throw "tar failed for $Spec (exit $LASTEXITCODE)" }
Write-Output "ok  $Spec -> $dest"
