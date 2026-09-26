#!/bin/zsh
cd -- "${0:A:h}"
if command -v node >/dev/null 2>&1; then
  node server.mjs
elif [[ -x /opt/homebrew/bin/node ]]; then
  /opt/homebrew/bin/node server.mjs
elif [[ -x /usr/local/bin/node ]]; then
  /usr/local/bin/node server.mjs
else
  echo "This launcher needs Node.js 20.11 or newer."
  echo "You can still double-click prototype.html and production.html to explore them."
  echo "See README.md for running the pages with Diffuse."
fi
read -r "?Press Return to close this window."
