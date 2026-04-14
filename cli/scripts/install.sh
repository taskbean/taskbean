#!/bin/bash
# taskbean install script
# Usage: curl -fsSL https://taskbean.ai/install | bash
set -euo pipefail

REPO="taskbean/taskbean"
INSTALL_DIR="${PREFIX:-$HOME/.local}/bin"

# Detect platform
OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)

case "$OS" in
  linux) PLATFORM="linux" ;;
  darwin) PLATFORM="darwin" ;;
  *) echo "❌ Unsupported OS: $OS"; exit 1 ;;
esac

case "$ARCH" in
  x86_64|amd64) ARCH="x64" ;;
  arm64|aarch64) ARCH="arm64" ;;
  *) echo "❌ Unsupported architecture: $ARCH"; exit 1 ;;
esac

BINARY="bean-${PLATFORM}-${ARCH}"
LATEST=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" | grep '"tag_name"' | sed -E 's/.*"([^"]+)".*/\1/')
URL="https://github.com/${REPO}/releases/download/${LATEST}/${BINARY}"

echo "🫘 installing taskbean ${LATEST} (${PLATFORM}-${ARCH})..."

mkdir -p "$INSTALL_DIR"
curl -fsSL "$URL" -o "${INSTALL_DIR}/bean"
chmod +x "${INSTALL_DIR}/bean"

# Also create taskbean symlink
ln -sf "${INSTALL_DIR}/bean" "${INSTALL_DIR}/taskbean"

echo "✅ Installed to ${INSTALL_DIR}/bean"
echo "   Run: bean --help"

# Check PATH
if [[ ":$PATH:" != *":${INSTALL_DIR}:"* ]]; then
  echo ""
  echo "⚠️  ${INSTALL_DIR} is not in your PATH."
  echo "   Add to your shell profile:"
  echo "   export PATH=\"${INSTALL_DIR}:\$PATH\""
fi
