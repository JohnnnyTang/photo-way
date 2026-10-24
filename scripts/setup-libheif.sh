#!/usr/bin/env bash
# Build libheif + libde265 (static, LGPL-3.0, no GPL codecs) with vcpkg for Photo Way.
# Usage: scripts/setup-libheif.sh [--universal]   (idempotent)
#   --universal   build both arm64-osx-pw and x64-osx-pw (macOS universal app)
# Env:   VCPKG_ROOT (default <repo>/.vcpkg), VCPKG_BINARY_SOURCES (respected by vcpkg)
# Prints the environment variables cargo needs and, when $GITHUB_ENV is set,
# appends them to it. See docs/spikes/S1-heic.md.
set -euo pipefail

VCPKG_TAG=2026.10.16
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
root="${VCPKG_ROOT:-$repo/.vcpkg}"
universal=0
[ "${1:-}" = "--universal" ] && universal=1

case "$(uname -s)" in
  Darwin)
    if [ "$universal" = 1 ]; then triplets="arm64-osx-pw x64-osx-pw"
    elif [ "$(uname -m)" = "arm64" ]; then triplets="arm64-osx-pw"
    else triplets="x64-osx-pw"; fi ;;
  *) echo "setup-libheif.sh supports macOS only (Windows: setup-libheif.ps1; Linux: install libheif-dev)" >&2; exit 1 ;;
esac

if [ ! -d "$root/.git" ]; then
  if [ -e "$root" ] && [ -n "$(ls -A "$root" 2>/dev/null)" ]; then
    echo "$root exists and is not a vcpkg checkout" >&2; exit 1
  fi
  git clone --depth 1 --branch "$VCPKG_TAG" https://github.com/microsoft/vcpkg "$root"
fi
[ -x "$root/vcpkg" ] || "$root/bootstrap-vcpkg.sh" -disableMetrics

for t in $triplets; do
  "$root/vcpkg" install "libheif[core]:$t" --overlay-triplets="$repo/vcpkg/triplets" --clean-after-build --disable-metrics
done

vars=(
  "VCPKG_ROOT=$root"
  "PKG_CONFIG_ALLOW_CROSS=1"
  "SYSTEM_DEPS_LIBHEIF_LINK=static"
  "MACOSX_DEPLOYMENT_TARGET=11.0"
  "PKG_CONFIG_LIBDIR_aarch64_apple_darwin=$root/installed/arm64-osx-pw/lib/pkgconfig"
  "PKG_CONFIG_LIBDIR_x86_64_apple_darwin=$root/installed/x64-osx-pw/lib/pkgconfig"
)
echo
echo "Environment for cargo:"
for v in "${vars[@]}"; do echo "  export $v"; done
if [ -n "${GITHUB_ENV:-}" ]; then
  printf '%s\n' "${vars[@]}" >> "$GITHUB_ENV"
  echo "Appended to \$GITHUB_ENV."
fi
