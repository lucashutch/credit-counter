#!/usr/bin/env bash
#
# install.sh — Build the Copilot Cost Tracker extension and install it directly
# into the local VS Code extensions directory (no Marketplace / no .vsix needed).
#
# Usage:
#   ./install.sh                 # build + install for VS Code (stable)
#   VSCODE_DIR=~/.vscode-insiders ./install.sh   # install into VS Code Insiders
#
set -euo pipefail

# --- Resolve paths --------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Read name/publisher/version straight from package.json (no jq dependency).
read_field() {
  node -p "require('./package.json').$1"
}

NAME="$(read_field name)"
PUBLISHER="$(read_field publisher)"
VERSION="$(read_field version)"

EXT_ID="${PUBLISHER}.${NAME}-${VERSION}"

# VS Code extensions directory (override with VSCODE_DIR for Insiders, etc.)
VSCODE_DIR="${VSCODE_DIR:-$HOME/.vscode}"
EXTENSIONS_DIR="${VSCODE_DIR}/extensions"
TARGET_DIR="${EXTENSIONS_DIR}/${EXT_ID}"

echo "==> Extension : ${EXT_ID}"
echo "==> Target    : ${TARGET_DIR}"

# --- Build ----------------------------------------------------------------
echo "==> Installing dependencies..."
npm install --silent

echo "==> Building production bundle..."
npm run package

if [[ ! -f "dist/extension.js" ]]; then
  echo "ERROR: build did not produce dist/extension.js" >&2
  exit 1
fi

# --- Install --------------------------------------------------------------
echo "==> Removing any previous install..."
rm -rf "$TARGET_DIR"
mkdir -p "$TARGET_DIR"

echo "==> Copying extension files..."
# Only the files needed at runtime.
cp -r dist "$TARGET_DIR/"
cp -r media "$TARGET_DIR/"
cp package.json "$TARGET_DIR/"
[[ -f README.md ]] && cp README.md "$TARGET_DIR/" || true
[[ -f LICENSE ]] && cp LICENSE "$TARGET_DIR/" || true

echo ""
echo "✅ Installed ${EXT_ID} to:"
echo "   ${TARGET_DIR}"
echo ""
echo "Reload VS Code (Developer: Reload Window) to activate the extension."
