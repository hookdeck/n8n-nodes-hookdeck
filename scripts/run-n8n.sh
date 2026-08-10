#!/usr/bin/env bash
#
# Launch a local n8n with this package linked in, for manual testing.
#
#   npm run build
#   npm link
#   mkdir -p ~/.n8n/custom && (cd ~/.n8n/custom && npm init -y && npm link @hookdeck/n8n-nodes-hookdeck)
#   ./scripts/run-n8n.sh
#
# The Hookdeck Trigger provisions a connection whose destination is the URL n8n
# advertises, and Hookdeck delivers over the public internet — so a localhost
# URL is rejected. Expose n8n through a tunnel and pass the public address:
#
#   cloudflared tunnel --url http://localhost:5678
#   WEBHOOK_URL=https://<subdomain>.trycloudflare.com ./scripts/run-n8n.sh
#
# Note that Hookdeck appends nothing to the destination path (the node sets
# path_forwarding_disabled), but n8n still matches its webhook path exactly.
#
set -euo pipefail

# n8n requires Node >=22.22. If the default `node` is older, point NODE_BIN at a
# newer install rather than changing the machine default, e.g.
#   NODE_BIN="$HOME/.nvm/versions/node/v24.11.1/bin" ./scripts/run-n8n.sh
if [ -n "${NODE_BIN:-}" ]; then
	export PATH="${NODE_BIN}:${PATH}"
fi

if ! node --version >/dev/null 2>&1; then
	echo "node not found on PATH" >&2
	exit 1
fi

node -e 'const [maj,min]=process.versions.node.split(".").map(Number);
if (maj < 22 || (maj === 22 && min < 22)) {
  console.error(`n8n needs Node >=22.22, found ${process.versions.node}. Set NODE_BIN to a newer install.`);
  process.exit(1);
}'

# n8n loads linked packages from this directory.
export N8N_CUSTOM_EXTENSIONS="${N8N_CUSTOM_EXTENSIONS:-${HOME}/.n8n/custom}"
export N8N_PORT="${N8N_PORT:-5678}"

# Local test instance: quieten anything that only matters in a real deployment.
export N8N_DIAGNOSTICS_ENABLED=false
export N8N_VERSION_NOTIFICATIONS_ENABLED=false
export N8N_SECURE_COOKIE=false

exec npx --yes "n8n@${N8N_VERSION:-latest}" start
