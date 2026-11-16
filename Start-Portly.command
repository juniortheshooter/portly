#!/bin/bash
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$HOME/.nvm/versions/node/$(ls -1 "$HOME/.nvm/versions/node" 2>/dev/null | tail -n 1)/bin:$PATH"
if ! command -v node >/dev/null 2>&1; then
  osascript -e 'display alert "Node.js Required" message "Please install Node.js (https://nodejs.org) to run Portly." as critical'
  exit 1
fi
exec node "$DIR/desktop-app.js"
