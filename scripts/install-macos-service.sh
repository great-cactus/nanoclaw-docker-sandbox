#!/bin/bash
# install-macos-service.sh — Install NanoClaw as a macOS launchd service
# Run this from macOS Terminal (NOT inside Docker/SSH container)
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLIST_TEMPLATE="$PROJECT_ROOT/launchd/com.nanoclaw.plist"
PLIST_DEST="$HOME/Library/LaunchAgents/com.nanoclaw.plist"
LABEL="com.nanoclaw"

echo "=== NanoClaw macOS Service Installer ==="
echo "Project: $PROJECT_ROOT"

# Check we're on macOS
if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Error: This script must be run on macOS, not inside a container."
  exit 1
fi

# Find node
NODE_PATH=""
for candidate in \
  "$(command -v node 2>/dev/null)" \
  /opt/homebrew/bin/node \
  /usr/local/bin/node \
  "$HOME/.nvm/versions/node/$(ls "$HOME/.nvm/versions/node/" 2>/dev/null | sort -V | tail -1)/bin/node"; do
  if [[ -x "$candidate" ]]; then
    NODE_PATH="$candidate"
    break
  fi
done

if [[ -z "$NODE_PATH" ]]; then
  echo "Error: Node.js not found. Install it with: brew install node"
  exit 1
fi

NODE_VERSION=$("$NODE_PATH" --version)
echo "Node: $NODE_PATH ($NODE_VERSION)"

# Rebuild node_modules for macOS if needed (may be Linux binaries from container)
echo ""
echo "Rebuilding node_modules for macOS..."
cd "$PROJECT_ROOT"
npm install --silent
npm run build

echo ""
echo "Installing launchd plist..."
mkdir -p "$HOME/Library/LaunchAgents"

# Fill in template placeholders
sed \
  -e "s|{{NODE_PATH}}|$NODE_PATH|g" \
  -e "s|{{PROJECT_ROOT}}|$PROJECT_ROOT|g" \
  -e "s|{{HOME}}|$HOME|g" \
  "$PLIST_TEMPLATE" > "$PLIST_DEST"

echo "Plist installed: $PLIST_DEST"

# Unload existing if any
launchctl unload "$PLIST_DEST" 2>/dev/null || true

# Load service
launchctl load "$PLIST_DEST"
echo ""
echo "Service loaded. NanoClaw will now start automatically on login."
echo ""
echo "Status:  launchctl list | grep nanoclaw"
echo "Logs:    tail -f $PROJECT_ROOT/logs/nanoclaw.log"
echo "Stop:    launchctl unload $PLIST_DEST"
echo "Restart: launchctl kickstart -k gui/\$(id -u)/$LABEL"
