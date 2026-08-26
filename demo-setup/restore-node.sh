#!/usr/bin/env bash
# Put @hookdeck/n8n-nodes-hookdeck back WITHOUT the n8n UI, for rehearsals.
#
# Why this exists: n8n's Public API will uninstall a community package but refuses
# to install one that is not on its vetted list —
#   POST /api/v1/community-packages -> 400 "Package ... is not vetted for installation"
# The UI has no such check, which is why the original install worked. Until 0.2.0 is
# verified, an API uninstall is a one-way door. This reverses it by doing what the UI
# does underneath: put the package in ~/.n8n/nodes, register it in the database, and
# restart n8n.
#
# Usage: ./restore-node.sh [version]     (default 0.2.0)
set -uo pipefail
REPO=/Users/leggetter/hookdeck/git/n8n-nodes-hookdeck
VERSION="${1:-0.2.0}"
PKG='@hookdeck/n8n-nodes-hookdeck'
NODES_DIR="$HOME/.n8n/nodes"

echo "1/4  install $PKG@$VERSION into $NODES_DIR"
mkdir -p "$NODES_DIR"
[ -f "$NODES_DIR/package.json" ] || echo '{"name":"installed-nodes","private":true,"dependencies":{}}' > "$NODES_DIR/package.json"
# --omit=peer matters: the n8n-workflow peer pulls isolated-vm, which needs node-gyp
# and fails to build on recent Node. The package itself has no runtime dependencies.
( cd "$NODES_DIR" && npm install "$PKG@$VERSION" --omit=dev --omit=peer --ignore-scripts --no-audit --no-fund >/dev/null 2>&1 )
V=$(node -p "require('$NODES_DIR/node_modules/$PKG/package.json').version" 2>/dev/null)
if [ -z "$V" ]; then
  echo "     npm route failed, falling back to the published tarball"
  TMP=$(mktemp -d)
  ( cd "$TMP" && npm pack "$PKG@$VERSION" >/dev/null 2>&1 && tar xzf ./*.tgz )
  mkdir -p "$NODES_DIR/node_modules/$PKG"
  cp -R "$TMP/package/." "$NODES_DIR/node_modules/$PKG/"
  rm -rf "$TMP"
  V=$(node -p "require('$NODES_DIR/node_modules/$PKG/package.json').version" 2>/dev/null)
fi
[ -z "$V" ] && { echo "     FAILED to place the package"; exit 1; }
echo "     on disk: $V"

echo "2/4  register it in the n8n database"
sqlite3 ~/.n8n/database.sqlite <<SQL
INSERT OR REPLACE INTO installed_packages (packageName, installedVersion, authorName, authorEmail, createdAt, updatedAt)
VALUES ('$PKG','$V','Hookdeck','support@hookdeck.com',
        STRFTIME('%Y-%m-%d %H:%M:%f','NOW'), STRFTIME('%Y-%m-%d %H:%M:%f','NOW'));
INSERT OR REPLACE INTO installed_nodes (name, type, latestVersion, package) VALUES
 ('Hookdeck Event Gateway','$PKG.hookdeckEventGateway',1,'$PKG'),
 ('Hookdeck Event Gateway Trigger','$PKG.hookdeckEventGatewayTrigger',1,'$PKG');
SQL
echo "     installed_packages + installed_nodes rows written"

echo "3/4  restart n8n (node descriptions are read once at startup)"
pkill -f "hookdeck listen" >/dev/null 2>&1 || true
PID=$(lsof -nP -iTCP:5678 -sTCP:LISTEN -t 2>/dev/null | head -1)
[ -n "$PID" ] && kill "$PID" 2>/dev/null
for i in $(seq 1 25); do lsof -nP -iTCP:5678 -sTCP:LISTEN -t >/dev/null 2>&1 || break; sleep 1; done
cd "$REPO"
NODE_BIN="$HOME/.asdf/installs/nodejs/22.23.2/bin" nohup ./scripts/run-n8n.sh > /tmp/n8n-restore.log 2>&1 &

echo "4/4  wait for n8n"
for i in $(seq 1 80); do
  code=$(curl -s -o /dev/null -m 3 -w "%{http_code}" http://localhost:5678/rest/settings 2>/dev/null)
  [ "$code" = "200" ] && { echo "     up after ~$((i*3))s"; break; }
  sleep 3
done

N8N_KEY=$(node --env-file-if-exists=.env -e 'process.stdout.write(process.env.N8N_API_KEY||"")')
echo
echo "registered nodes:"
curl -s -m 15 -H "X-N8N-API-KEY: $N8N_KEY" "http://localhost:5678/api/v1/community-packages" | python3 -c "
import sys,json
for p in json.load(sys.stdin):
    print('  '+p['packageName']+' '+p['installedVersion'])
    for n in p.get('installedNodes',[]): print('     '+n['type'])
" 2>/dev/null || echo "  (none — check /tmp/n8n-restore.log)"
