#!/usr/bin/env bash
# Reset examples/ai-incident-agent.json to a state where the demo runs again.
#
# The one non-obvious thing: Hookdeck aggregates delivery issues by
# (webhook_id, error_code, response_status). Once an issue exists for a
# connection, later failures JOIN it and no `issue.opened` notification fires —
# and dismissing the issue does NOT reset that. The only reliable way to get a
# fresh `issue.opened` is a NEW connection id, so this deletes the agent
# workflow's connection and lets n8n re-provision it on activation.
#
# `hookdeck listen` is started AFTER activation, because the CLI attaches to the
# connections that exist when it starts.
#
# Usage: ./reset-demo.sh [--no-listen]
#
#   --no-listen  do not start `hookdeck listen`. Use this when n8n is reachable
#                from the internet (WEBHOOK_URL set), because then the trigger
#                provisions an HTTP destination and the CLI is not involved.
#
# Read demo-setup/README.md first. This deletes Hookdeck resources.
set -uo pipefail

# Everything is resolved from where this file lives, so the script works from
# any checkout and any working directory.
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd -- "$SCRIPT_DIR/.." && pwd)
cd "$REPO_ROOT" || exit 1

API=https://api.hookdeck.com/2025-07-01
N8N_URL="${N8N_URL:-http://localhost:5678}"

# The workflow and source names in examples/ai-incident-agent.json. Nothing is
# looked up by id, so this runs against any n8n instance and any Hookdeck
# project rather than the one the demo was first built on.
AGENT_WORKFLOW="Hookdeck — AI incident agent"
AGENT_SOURCE="n8n-example-hookdeck-issues"

LISTEN=1
for arg in "$@"; do
  case "$arg" in
    --no-listen) LISTEN=0 ;;
    -h | --help)
      sed -n '2,20p' "${BASH_SOURCE[0]}"
      exit 0
      ;;
    *)
      echo "unknown flag: $arg (see --help)" >&2
      exit 2
      ;;
  esac
done

die() {
  echo
  echo "FAILED: $*" >&2
  exit 1
}

# Read stdin as JSON and evaluate an expression against it, so the only
# prerequisites are node and curl — no jq, no python.
#   ... | jsonq 'data.models.map(m => m.id).join("\n")' [extra args, as argv[0..]]
jsonq() {
  node -e '
    let s = "";
    process.stdin.on("data", d => s += d).on("end", () => {
      let data;
      try { data = JSON.parse(s || "null"); } catch { process.exit(3); }
      const argv = process.argv.slice(2);
      const out = new Function("data", "argv", "return (" + process.argv[1] + ");")(data, argv);
      process.stdout.write(out === undefined || out === null ? "" : String(out));
    });
  ' "$@"
}

# -f so an HTTP error is a non-zero exit here rather than an error document that
# parses to nothing three steps later.
n8n_api() { curl -sSf -m 30 -H "X-N8N-API-KEY: $N8N_API_KEY" "$@"; }
hd_api() {
  curl -sSf -m 30 -H "Authorization: Bearer $HOOKDECK_EG_API_KEY" \
    -H "Content-Type: application/json" "$@"
}
status_of() { curl -sS -m 15 -o /dev/null -w '%{http_code}' "$@"; }

echo "1/7  prerequisites"

for cmd in curl node; do
  command -v "$cmd" >/dev/null 2>&1 || die "$cmd is not installed."
done
if [ "$LISTEN" = "1" ] && ! command -v hookdeck >/dev/null 2>&1; then
  die "the Hookdeck CLI is not installed (https://hookdeck.com/docs/cli), or pass --no-listen."
fi

NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "${NODE_MAJOR:-0}" -ge 20 ] || die "node 20 or newer is required (found $(node -v))."

# Anything already exported wins; otherwise fall back to .env in the repo root.
env_or_dotenv() {
  node --env-file-if-exists="$REPO_ROOT/.env" \
    -e 'process.stdout.write(process.env[process.argv[1]] || "")' "$1"
}
N8N_API_KEY="${N8N_API_KEY:-$(env_or_dotenv N8N_API_KEY)}"
HOOKDECK_EG_API_KEY="${HOOKDECK_EG_API_KEY:-$(env_or_dotenv HOOKDECK_EG_API_KEY)}"

[ -n "$N8N_API_KEY" ] ||
  die "N8N_API_KEY is not set. Create an API key in n8n (Settings -> API) and put it in .env."
[ -n "$HOOKDECK_EG_API_KEY" ] ||
  die "HOOKDECK_EG_API_KEY is not set. Copy a project API key from the Hookdeck dashboard into .env."

case "$(status_of -H "X-N8N-API-KEY: $N8N_API_KEY" "$N8N_URL/api/v1/workflows?limit=1")" in
  200) ;;
  000) die "n8n is not answering on $N8N_URL. Start it, or set N8N_URL." ;;
  401 | 403) die "n8n rejected N8N_API_KEY. Create a fresh key in n8n (Settings -> API)." ;;
  *) die "unexpected reply from $N8N_URL/api/v1/workflows — is that an n8n instance?" ;;
esac

case "$(status_of -H "Authorization: Bearer $HOOKDECK_EG_API_KEY" "$API/sources?limit=1")" in
  200) ;;
  000) die "could not reach $API." ;;
  401 | 403) die "Hookdeck rejected HOOKDECK_EG_API_KEY. Copy the project API key again." ;;
  *) die "unexpected reply from $API/sources." ;;
esac

AGENT_ID=$(n8n_api "$N8N_URL/api/v1/workflows?limit=250" |
  jsonq '((data && data.data) || []).filter(w => w.name === argv[0]).map(w => w.id)[0]' "$AGENT_WORKFLOW")
[ -n "$AGENT_ID" ] ||
  die "no workflow named \"$AGENT_WORKFLOW\". Import examples/ai-incident-agent.json and publish it once."

# The delivery issue trigger is what turns a failed attempt into an issue, and
# an issue is what the agent reacts to. Without one the demo has no first half,
# so stop here rather than half-running.
ISSUE_TRIGGER=$(hd_api "$API/issue-triggers?limit=250" |
  jsonq '((data && data.models) || []).filter(t => t.type === "delivery").map(t => t.id)[0]')
[ -n "$ISSUE_TRIGGER" ] || die "this Hookdeck project has no delivery issue trigger.
     Create one in the dashboard (Issues -> Issue triggers), then re-run."

echo "     workflow $AGENT_ID, issue trigger $ISSUE_TRIGGER"

echo "2/7  stop any hookdeck listen"
pkill -f "hookdeck listen" >/dev/null 2>&1
sleep 1

echo "3/7  deactivate the agent workflow"
n8n_api -X POST "$N8N_URL/api/v1/workflows/$AGENT_ID/deactivate" -o /dev/null ||
  die "could not deactivate workflow $AGENT_ID."

echo "4/7  delete its connection, its orphaned destinations, and dismiss open issues"
CONNS=$(hd_api "$API/connections?limit=250" |
  jsonq '((data && data.models) || [])
    .filter(c => c.source && c.source.name === argv[0])
    .map(c => c.id).join("\n")' "$AGENT_SOURCE")
n=0
for id in $CONNS; do
  hd_api -X DELETE "$API/connections/$id" -o /dev/null && n=$((n + 1))
done
echo "     removed $n connection(s) on $AGENT_SOURCE"

# Deactivating a workflow orphans the destination it provisioned rather than
# deleting it (issue #13), so a project accrues clutter across resets. Only
# destinations this node created — they are named n8n-* — and only ones no
# connection still points at.
LIVE=$(hd_api "$API/connections?limit=250" |
  jsonq '((data && data.models) || [])
    .map(c => c.destination_id || (c.destination && c.destination.id)).join(",")')
ORPHANS=$(hd_api "$API/destinations?limit=250" |
  jsonq '((data && data.models) || [])
    .filter(d => /^n8n-/.test(d.name || "") && !argv[0].split(",").includes(d.id))
    .map(d => d.id).join("\n")' "$LIVE")
n=0
for id in $ORPHANS; do
  hd_api -X DELETE "$API/destinations/$id" -o /dev/null && n=$((n + 1))
done
echo "     removed $n orphaned n8n destination(s)"

ISSUES=$(hd_api "$API/issues?status=OPENED&limit=250" |
  jsonq '((data && data.models) || []).map(i => i.id).join("\n")')
n=0
for id in $ISSUES; do
  hd_api -X PUT "$API/issues/$id" -d '{"status":"IGNORED"}' -o /dev/null && n=$((n + 1))
done
echo "     dismissed $n open issue(s)"

echo "5/7  point the issue.opened notification at $AGENT_SOURCE"
# Webhook notifications are project-level, not a channel on the issue trigger:
# adding channels.webhook to an issue trigger returns 200 and silently drops it.
AGENT_SRC_ID=$(hd_api "$API/sources?name=$AGENT_SOURCE" |
  jsonq '((data && data.models) || []).map(s => s.id)[0]')
[ -n "$AGENT_SRC_ID" ] || die "no Hookdeck source named $AGENT_SOURCE.
     Publish \"$AGENT_WORKFLOW\" once so the trigger provisions it, then re-run."
hd_api -X PUT "$API/notifications/webhooks" \
  -d "{\"enabled\":true,\"topics\":[\"issue.opened\"],\"source_id\":\"$AGENT_SRC_ID\"}" -o /dev/null ||
  die "could not configure the issue.opened notification."
echo "     -> $AGENT_SRC_ID"

echo "6/7  activate the agent workflow"
n8n_api -X POST "$N8N_URL/api/v1/workflows/$AGENT_ID/activate" -o /dev/null ||
  die "could not activate workflow $AGENT_ID."

AGENT_CONN=""
for _ in $(seq 1 30); do
  AGENT_CONN=$(hd_api "$API/connections?limit=250" |
    jsonq '((data && data.models) || [])
      .filter(c => c.source && c.source.name === argv[0]).map(c => c.id)[0]' "$AGENT_SOURCE")
  [ -n "$AGENT_CONN" ] && break
  sleep 1
done
[ -n "$AGENT_CONN" ] ||
  die "activation did not provision a connection on $AGENT_SOURCE. Check the n8n log."

if [ "$LISTEN" = "1" ]; then
  echo "     attaching the CLI to the connections that now exist"
  LOG="${TMPDIR:-/tmp}/hookdeck-listen.log"
  : >"$LOG"
  nohup hookdeck listen 5678 '*' --output compact --no-healthcheck >"$LOG" 2>&1 &
  attached=0
  for _ in $(seq 1 30); do
    attached=$(grep -c "Forwards to" "$LOG" 2>/dev/null || true)
    [ "${attached:-0}" -ge 1 ] && break
    sleep 1
  done
  echo "     attached connections: ${attached:-0}"
  # An unattached CLI is worse than a failed reset: Hookdeck accepts the event
  # and nothing reaches n8n, so the demo looks broken for the wrong reason.
  [ "${attached:-0}" -ge 1 ] ||
    die "the CLI attached to no connections. See $LOG — you may need \`hookdeck login\`."
else
  echo "     skipping hookdeck listen (--no-listen)"
fi

echo "7/7  scope the delivery issue trigger to every connection except the agent's"
# Without this the agent's own connection can raise an issue, which notifies the
# agent, which is a loop. The workflow's Async Retry acknowledgement makes that
# unlikely; this makes it impossible.
WATCHED=$(hd_api "$API/connections?limit=250" |
  jsonq '((data && data.models) || [])
    .filter(c => c.id !== argv[0])
    .map(c => JSON.stringify(c.id)).join(",")' "$AGENT_CONN")
[ -n "$WATCHED" ] || die "this project has no connection other than the agent's own.
     The agent reacts to a delivery failing somewhere else, so create the failing
     side first — see demo-setup/README.md — then re-run."
hd_api -X PUT "$API/issue-triggers/$ISSUE_TRIGGER" \
  -d "{\"configs\":{\"strategy\":\"first_attempt\",\"connections\":[$WATCHED]}}" -o /dev/null ||
  die "could not scope issue trigger $ISSUE_TRIGGER."
echo "     watching: $WATCHED"

echo
echo "READY"
echo "  agent workflow   : $N8N_URL/workflow/$AGENT_ID"
echo "  agent connection : $AGENT_CONN  (excluded from the issue trigger)"
echo
echo "  Make a delivery fail on one of the watched connections. The issue opens on"
echo "  the first failed attempt, Hookdeck posts issue.opened to $AGENT_SOURCE, and"
echo "  the agent workflow runs on its own a few seconds later."
