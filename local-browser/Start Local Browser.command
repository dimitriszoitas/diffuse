#!/bin/bash
# Double-click on macOS. All state stays inside this companion's .local folder.
set -eu
cd -- "$(dirname -- "$0")"
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "Diffuse needs Node.js 20 or newer. Install it from https://nodejs.org, then open this file again."
  read -r -p "Press Return to close this window. "
  exit 1
fi
if ! node --input-type=module -e 'if (Number(process.versions.node.split(".")[0]) < 20) process.exit(1)'; then
  echo "Diffuse needs Node.js 20 or newer. Update Node.js, then open this file again."
  read -r -p "Press Return to close this window. "
  exit 1
fi
if [ ! -f node_modules/@playwright/mcp/cli.js ] || [ ! -f node_modules/@modelcontextprotocol/sdk/package.json ] || [ ! -f node_modules/axe-core/axe.min.js ]; then
  echo "Installing Diffuse's pinned local browser dependencies. This first setup needs internet access."
  npm ci --ignore-scripts --no-audit --no-fund
fi
if ! node --input-type=module -e 'import { chromium } from "playwright"; import { accessSync } from "node:fs"; accessSync(chromium.executablePath());' >/dev/null 2>&1; then
  echo "Installing the dedicated Chromium audit browser. Your personal Chrome profile is not changed."
  npm run install:browser
fi
echo "Starting Diffuse's local browser companion. Keep this window open while using interactive reviews."
echo "The pairing token is stored in: $(pwd)/.local/pairing-token"
echo "Press Control-C to stop the companion."
node server.mjs
