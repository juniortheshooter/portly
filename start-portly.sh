#!/usr/bin/env bash
set -e
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"
export PATH="/usr/local/bin:/usr/bin:/bin:$HOME/.local/bin:$HOME/.nvm/current/bin:$PATH"
if ! command -v node >/dev/null 2>&1; then
  echo "Error: Node.js is required to run Portly (https://nodejs.org)." >&2
  exit 1
fi
exec node "$DIR/desktop-app.js"
