#!/usr/bin/env bash
# Return n8n + Hookdeck to a "never seen this node before" state, ready to record.
#
#   ./pre-take-reset.sh              full teardown (workflows, credentials, package, Hookdeck)
#   ./pre-take-reset.sh --keep-creds keep the credentials (for rehearsals — saves re-pasting keys)
#   ./pre-take-reset.sh --dry-run    show what would go, change nothing
#
# ⚠️  THE PACKAGE CAN ONLY BE REINSTALLED FROM THE n8n UI.
#     n8n's Public API will uninstall it happily, but POST /api/v1/community-packages
#     refuses with "Package ... is not vetted for installation" — the UI has no such
#     check. That is fine for the take (you install on camera anyway), but for a
#     rehearsal use ./restore-node.sh, which puts it back without the UI.
set -uo pipefail
REPO=/Users/leggetter/hookdeck/git/n8n-nodes-hookdeck
cd "$REPO"

PKG='@hookdeck/n8n-nodes-hookdeck'
PKG_ENC='@hookdeck%2Fn8n-nodes-hookdeck'
KEEP_CREDS=0
DRY=0
for a in "$@"; do
  case "$a" in
    --keep-creds) KEEP_CREDS=1 ;;
    --dry-run)    DRY=1 ;;
    *) echo "unknown flag: $a"; exit 2 ;;
  esac
done
run() { [ "$DRY" = "1" ] && { echo "       [dry-run] $*"; return 0; }; "$@" >/dev/null 2>&1; }

N8N_KEY=$(node --env-file-if-exists=.env -e 'process.stdout.write(process.env.N8N_API_KEY||"")')
[ -z "$N8N_KEY" ] && { echo "N8N_API_KEY missing from .env"; exit 1; }
api() { curl -s -m 30 -H "X-N8N-API-KEY: $N8N_KEY" "$@"; }

echo "1/5  stop hookdeck listen"
run pkill -f "hookdeck listen"
sleep 1

echo "2/5  delete workflows that use the Hookdeck node"
api "http://localhost:5678/api/v1/workflows?limit=250" | python3 -c "
import sys,json
d=json.load(sys.stdin).get('data',[])
hits=[w for w in d if any('hookdeck' in n.get('type','').lower() for n in w.get('nodes',[]))]
for w in hits: print(w['id']+'\t'+w['name'])
" > /tmp/_wf.txt
if [ ! -s /tmp/_wf.txt ]; then
  echo "       none found"
else
  while IFS=$'\t' read -r id name; do
    [ -z "$id" ] && continue
    echo "       $id  $name"
    run api -X POST "http://localhost:5678/api/v1/workflows/$id/deactivate"
    run api -X DELETE "http://localhost:5678/api/v1/workflows/$id"
  done < /tmp/_wf.txt
fi

echo "3/5  delete credentials"
if [ "$KEEP_CREDS" = "1" ]; then
  echo "       skipped (--keep-creds)"
else
  for row in $(sqlite3 ~/.n8n/database.sqlite \
      "select id||'|'||type from credentials_entity where type in ('hookdeckEventGatewayApi','anthropicApi');" 2>/dev/null); do
    cid="${row%%|*}"; ctype="${row##*|}"
    echo "       $cid  $ctype"
    run api -X DELETE "http://localhost:5678/api/v1/credentials/$cid"
  done
fi

echo "4/5  uninstall the community package"
if sqlite3 ~/.n8n/database.sqlite "select count(*) from installed_packages where packageName='$PKG';" 2>/dev/null | grep -q '^1$'; then
  echo "       $PKG"
  run api -X DELETE "http://localhost:5678/api/v1/community-packages/$PKG_ENC"
else
  echo "       not installed"
fi

echo "5/5  clear the Hookdeck project"
if [ "$DRY" = "1" ]; then
  echo "       [dry-run] would delete all connections, sources, destinations and dismiss open issues"
else
  node --env-file-if-exists=.env -e '
  const k=process.env.HOOKDECK_EG_API_KEY, h={Authorization:"Bearer "+k,"Content-Type":"application/json"};
  (async()=>{
    for (const kind of ["connections","sources","destinations"]) {
      const j=await (await fetch("https://api.hookdeck.com/2025-07-01/"+kind+"?limit=250",{headers:h})).json();
      for (const m of j.models||[]) await fetch("https://api.hookdeck.com/2025-07-01/"+kind+"/"+m.id,{method:"DELETE",headers:h});
      console.log("       removed "+(j.models||[]).length+" "+kind);
    }
    const iss=await (await fetch("https://api.hookdeck.com/2025-07-01/issues?status=OPENED&limit=250",{headers:h})).json();
    for (const i of iss.models||[]) await fetch("https://api.hookdeck.com/2025-07-01/issues/"+i.id,{method:"PUT",headers:h,body:JSON.stringify({status:"IGNORED"})});
    console.log("       dismissed "+(iss.models||[]).length+" open issues");
  })();'
fi

echo
if [ "$DRY" = "1" ]; then echo "DRY RUN — nothing changed"; exit 0; fi
echo "READY TO RECORD"
echo "  n8n            : http://localhost:5678"
echo "  install as      : $PKG   (Settings -> Community nodes)"
echo "  import after    : demo-setup/video-stripe-idempotency.json"
echo "                    demo-setup/video-ai-agent.json"
echo
echo "  Rehearsing instead of recording? ./restore-node.sh puts the package back"
echo "  without the UI — the Public API refuses to reinstall it."
