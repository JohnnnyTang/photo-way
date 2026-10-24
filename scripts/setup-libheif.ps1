# Build libheif + libde265 (static, LGPL-3.0, no GPL codecs) with vcpkg for Photo Way.
# Usage: pwsh scripts/setup-libheif.ps1        (idempotent; safe to re-run)
# Env:   VCPKG_ROOT            use/clone vcpkg here (default: <repo>/.vcpkg)
#        VCPKG_BINARY_SOURCES  respected by vcpkg (CI sets a files cache)
# Prints the environment variables cargo needs and, when $GITHUB_ENV is set,
# appends them to it. See docs/spikes/S1-heic.md.
$ErrorActionPreference = 'Stop'
$VcpkgTag = '2026.10.16'
$Triplet = 'x64-windows-static-rel'

$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$root = if ($env:VCPKG_ROOT) { $env:VCPKG_ROOT } else { Join-Path $repo '.vcpkg' }

if (-not (Test-Path (Join-Path $root '.git'))) {
    if ((Test-Path $root) -and (Get-ChildItem $root -Force | Select-Object -First 1)) {
        throw "$root exists and is not a vcpkg checkout"
    }
    git clone --depth 1 --branch $VcpkgTag https://github.com/microsoft/vcpkg $root
    if ($LASTEXITCODE -ne 0) { throw 'git clone vcpkg failed' }
}
$exe = Join-Path $root 'vcpkg.exe'
if (-not (Test-Path $exe)) {
    & (Join-Path $root 'bootstrap-vcpkg.bat') -disableMetrics
    if ($LASTEXITCODE -ne 0) { throw 'bootstrap-vcpkg failed' }
}

& $exe install "libheif[core]:$Triplet" "--overlay-triplets=$repo/vcpkg/triplets" --clean-after-build --disable-metrics
if ($LASTEXITCODE -ne 0) { throw 'vcpkg install failed' }

$vars = [ordered]@{
    VCPKG_ROOT      = $root
    VCPKGRS_TRIPLET = $Triplet
}
Write-Host ''
Write-Host 'Environment for cargo (PowerShell):'
foreach ($k in $vars.Keys) { Write-Host ('  $env:{0} = "{1}"' -f $k, $vars[$k]) }
if ($env:GITHUB_ENV) {
    foreach ($k in $vars.Keys) { Add-Content -Path $env:GITHUB_ENV -Value ('{0}={1}' -f $k, $vars[$k]) -Encoding utf8 }
    Write-Host 'Appended to $GITHUB_ENV.'
}
