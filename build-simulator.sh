#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PXL_SOFTWARE_REPO="${PXL_SOFTWARE_REPO:-$(cd "$SCRIPT_DIR/../pxl-software" && pwd)}"
SIMULATOR_HOST="$PXL_SOFTWARE_REPO/src/Pxl.Simulator.Host"
OUT_DIR="$SCRIPT_DIR/bin"

if [ ! -d "$SIMULATOR_HOST" ]; then
  echo "Error: Pxl.Simulator.Host not found at $SIMULATOR_HOST"
  echo "Set PXL_SOFTWARE_REPO to the pxl-software repo root."
  exit 1
fi

ALL_RIDS=(
  osx-arm64
  osx-x64
  linux-x64
  linux-arm64
  win-x64
)

# Detect current platform RID
detect_current_rid() {
  local os arch
  os="$(uname -s)"
  arch="$(uname -m)"
  case "$os" in
    Darwin) case "$arch" in arm64) echo "osx-arm64";; *) echo "osx-x64";; esac;;
    Linux)  case "$arch" in aarch64) echo "linux-arm64";; *) echo "linux-x64";; esac;;
    *)      echo "win-x64";;
  esac
}

# Determine which RIDs to build
if [ "$1" = "--current" ]; then
  RIDS=("$(detect_current_rid)")
elif [ $# -gt 0 ]; then
  RIDS=("$@")
else
  RIDS=("${ALL_RIDS[@]}")
fi

echo "=== Building Simulator UI ==="
cd "$PXL_SOFTWARE_REPO"
npm i --silent

cd src/pxl-receiver-canvas
npm run build --silent

cd ../pxl-simulator-ui
npm run build --silent

echo "=== Publishing Simulator Host ==="
rm -rf "$OUT_DIR"

for RID in "${RIDS[@]}"; do
  echo "--- $RID ---"
  dotnet publish "$SIMULATOR_HOST/Pxl.Simulator.Host.fsproj" \
    -c Release \
    -r "$RID" \
    --self-contained \
    -p:PublishSingleFile=true \
    -p:IncludeAllContentForSelfExtract=true \
    -p:EnableCompressionInSingleFile=true \
    -o "$OUT_DIR/$RID"
done

# Clean up: remove PDB files and dev-only config from output
for RID in "${RIDS[@]}"; do
  rm -f "$OUT_DIR/$RID"/*.pdb
  rm -f "$OUT_DIR/$RID"/spa.proxy.json
  rm -f "$OUT_DIR/$RID"/appsettings.Development.json
done

echo ""
echo "=== Done ==="
for RID in "${RIDS[@]}"; do
  echo "$RID:"
  ls -lh "$OUT_DIR/$RID/"
done
