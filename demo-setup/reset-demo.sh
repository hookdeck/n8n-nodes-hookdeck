#!/usr/bin/env bash
# Reset the Hookdeck n8n demo to a recordable state.
#
# The one non-obvious thing: Hookdeck aggregates delivery issues by
# (webhook_id, error_code, response_status). Once an issue exists for a
# connection, later failures JOIN it and no `issue.opened` notification fires —
# and dismissing the issue does NOT reset that. The only reliable way to get a
# fresh `issue.opened` is a NEW connection id, so this deletes the connection
# and lets n8n re-provision it on activation.
#
# `hookdeck listen` is started AFTER activation, because the CLI attaches to
# the connections that exist when it starts.
#
# Usage: ./reset-demo.sh
set -uo pipefail
REPO=/Users/leggetter/hookdeck/git/n8n-nodes-hookdeck
cd "$REPO"

F1=eQaQ9cqD32TAska9            # Demo 1 — Stripe ingestion
F2=9E3bJ86vWEs0jJij            # Demo 2 — Ingestion incident
ISSUE_TRIGGER=it_6ewxqCxQnQjfLn

N8N_KEY=$(node --env-file-if-exists=.env -e 'process.stdout.write(process.env.N8N_API_KEY||"")')
api() { curl -s -m 30 -H "X-N8N-API-KEY: $N8N_KEY" "$@"; }
hd()  { node --env-file-if-exists=.env -e "$1"; }

echo "1/6  stop any hookdeck listen"
pkill -f "hookdeck listen" >/dev/null 2>&1 || true
sleep 1

echo "2/6  deactivate both workflows"
api -X POST "http://localhost:5678/api/v1/workflows/$F1/deactivate" -o /dev/null
api -X POST "http://localhost:5678/api/v1/workflows/$F2/deactivate" -o /dev/null

echo "3/6  clear connections + destinations, dismiss open issues"
hd '
const k=process.env.HOOKDECK_EG_API_KEY, h={Authorization:"Bearer "+k,"Content-Type":"application/json"};
(async()=>{
  for (const kind of ["connections","destinations"]) {
    const j=await (await fetch("https://api.hookdeck.com/2025-07-01/"+kind+"?limit=250",{headers:h})).json();
    for (const m of j.models||[]) await fetch("https://api.hookdeck.com/2025-07-01/"+kind+"/"+m.id,{method:"DELETE",headers:h});
    console.log("     removed "+(j.models||[]).length+" "+kind);
  }
  const iss=await (await fetch("https://api.hookdeck.com/2025-07-01/issues?status=OPENED&limit=250",{headers:h})).json();
  for (const i of iss.models||[]) await fetch("https://api.hookdeck.com/2025-07-01/issues/"+i.id,{method:"PUT",headers:h,body:JSON.stringify({status:"IGNORED"})});
  console.log("     dismissed "+(iss.models||[]).length+" open issues");
})();'

echo "4/6  re-assert issue.opened -> demo-issues source"
hd '
const k=process.env.HOOKDECK_EG_API_KEY,h={Authorization:"Bearer "+k,"Content-Type":"application/json"};
(async()=>{
  const src=await (await fetch("https://api.hookdeck.com/2025-07-01/sources?name=demo-issues",{headers:h})).json();
  const r=await fetch("https://api.hookdeck.com/2025-07-01/notifications/webhooks",{method:"PUT",headers:h,
    body:JSON.stringify({enabled:true,topics:["issue.opened"],source_id:src.models[0].id})});
  console.log("     -> HTTP "+r.status);
})();'

echo "5/6  activate both workflows, then attach hookdeck listen"
api -X POST "http://localhost:5678/api/v1/workflows/$F1/activate" -o /dev/null
api -X POST "http://localhost:5678/api/v1/workflows/$F2/activate" -o /dev/null
sleep 3
nohup hookdeck listen 5678 '*' --output compact --no-healthcheck > /tmp/hookdeck-listen.log 2>&1 &
n=0
for i in $(seq 1 25); do
  n=$(grep -c "Forwards to" /tmp/hookdeck-listen.log 2>/dev/null || true)
  [ "${n:-0}" -ge 2 ] && break
  sleep 1
done
echo "     attached connections: ${n:-0}"
if [ "${n:-0}" -lt 2 ]; then
  echo "     ABORT: CLI not attached to both connections — events would not be recorded at all"
  exit 1
fi

echo "6/6  scope the delivery issue trigger to Flow 1's connection only"
CONN=$(hookdeck gateway connection list --output json | python3 -c '
import sys,json;d=json.load(sys.stdin);m=d.get("models",d) if isinstance(d,dict) else d
print([c["id"] for c in m if c.get("source",{}).get("name")=="demo-stripe"][0])')
CODE=$(hd "
const k=process.env.HOOKDECK_EG_API_KEY,h={Authorization:'Bearer '+k,'Content-Type':'application/json'};
fetch('https://api.hookdeck.com/2025-07-01/issue-triggers/$ISSUE_TRIGGER',{method:'PUT',headers:h,
 body:JSON.stringify({configs:{strategy:'first_attempt',connections:['$CONN']}})}).then(r=>process.stdout.write(String(r.status)));")
echo "     scoped to $CONN -> HTTP $CODE"

SRC_URL=$(hookdeck gateway source list --output json | python3 -c '
import sys,json;d=json.load(sys.stdin);m=d.get("models",d) if isinstance(d,dict) else d
print([s["url"] for s in m if s["name"]=="demo-stripe"][0])')
echo
echo "READY"
echo "  connection : $CONN"
echo "  source URL : $SRC_URL"
