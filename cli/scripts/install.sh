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
SUMS_URL="https://github.com/${REPO}/releases/download/${LATEST}/SHA256SUMS"

echo "🫘 installing taskbean ${LATEST} (${PLATFORM}-${ARCH})..."

mkdir -p "$INSTALL_DIR"

# Download into a temp file first so we can verify before moving into place.
# Trust boundary is HTTPS to github.com — same as bun/deno/gh.
TMP_BIN="$(mktemp "${TMPDIR:-/tmp}/bean.XXXXXX")"
TMP_SUMS="$(mktemp "${TMPDIR:-/tmp}/SHA256SUMS.XXXXXX")"
trap 'rm -f "$TMP_BIN" "$TMP_SUMS"' EXIT

curl -fsSL "$URL" -o "$TMP_BIN"
curl -fsSL "$SUMS_URL" -o "$TMP_SUMS"

# Pick the line for our binary and verify.
EXPECTED_LINE=$(grep "  ${BINARY}$" "$TMP_SUMS" || true)
if [ -z "$EXPECTED_LINE" ]; then
  echo "❌ SHA256SUMS does not contain an entry for ${BINARY}"
  exit 1
fi
EXPECTED_HASH=$(echo "$EXPECTED_LINE" | awk '{print $1}')

if command -v sha256sum >/dev/null 2>&1; then
  ACTUAL_HASH=$(sha256sum "$TMP_BIN" | awk '{print $1}')
elif command -v shasum >/dev/null 2>&1; then
  ACTUAL_HASH=$(shasum -a 256 "$TMP_BIN" | awk '{print $1}')
else
  echo "❌ Neither sha256sum nor shasum is available — cannot verify download."
  exit 1
fi

if [ "$EXPECTED_HASH" != "$ACTUAL_HASH" ]; then
  echo "❌ Checksum mismatch for ${BINARY}"
  echo "   expected: $EXPECTED_HASH"
  echo "   actual:   $ACTUAL_HASH"
  exit 1
fi

echo "🔒 SHA256 verified: $ACTUAL_HASH"

mv "$TMP_BIN" "${INSTALL_DIR}/bean"
chmod +x "${INSTALL_DIR}/bean"

# Also create taskbean symlink
ln -sf "${INSTALL_DIR}/bean" "${INSTALL_DIR}/taskbean"

# Write install-channel marker so `bean upgrade` routes through the binary
# path rather than npm.
mkdir -p "$HOME/.taskbean"
echo "binary" > "$HOME/.taskbean/.install-channel"

echo "✅ Installed to ${INSTALL_DIR}/bean"
echo "   Run: bean --help"

# Check PATH
if [[ ":$PATH:" != *":${INSTALL_DIR}:"* ]]; then
  echo ""
  echo "⚠️  ${INSTALL_DIR} is not in your PATH."
  echo "   Add to your shell profile:"
  echo "   export PATH=\"${INSTALL_DIR}:\$PATH\""
fi
