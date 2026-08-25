#!/usr/bin/env bash
# Fire the demo chain and print a timing table. Usage: ./run-demo.sh <label>
set -uo pipefail
REPO=/Users/leggetter/hookdeck/git/n8n-nodes-hookdeck; cd "$REPO"
LABEL="${1:-run}"
F1=eQaQ9cqD32TAska9; F2=9E3bJ86vWEs0jJij
KEY=$(node --env-file-if-exists=.env -e 'process.stdout.write(process.env.N8N_API_KEY||"")')
api(){ curl -s -m 20 -H "X-N8N-API-KEY: $KEY" "$@"; }
last(){ api "http://localhost:5678/api/v1/executions?workflowId=$1&limit=1" | python3 -c "
import sys,json;d=json.load(sys.stdin).get('data',[]);print(d[0]['id'] if d else 0)"; }
SRC=$(hookdeck gateway source list --output json | python3 -c "
import sys,json;d=json.load(sys.stdin);m=d.get('models',d) if isinstance(d,dict) else d
print([s['url'] for s in m if s['name']=='demo-stripe'][0])")
B1=$(last $F1); B2=$(last $F2)

echo "=== $LABEL ==="
T0=$(date +%s)
echo "  [0s]   sending payment_intent.succeeded (happy path)"
curl -s -o /dev/null -m 10 -X POST "$SRC" -H 'content-type: application/json' \
  -d '{"id":"evt_ok","type":"payment_intent.succeeded","data":{"object":{"id":"pi_ok","amount":2000}}}'
for i in $(seq 1 40); do
  x=$(api "http://localhost:5678/api/v1/executions?workflowId=$F1&limit=1" | python3 -c "
import sys,json;d=json.load(sys.stdin).get('data',[])
print(d[0]['status'] if d and int(d[0]['id'])>$B1 and d[0].get('stoppedAt') else '')" 2>/dev/null)
  [ -n "$x" ] && break; sleep 1
done
T_OK=$(( $(date +%s) - T0 )); echo "  [${T_OK}s]   flow1 happy path: $x"

B1=$(last $F1)
TS=$(date +%s)
echo "  ---   sending ONE payment_intent.payment_failed (opens the incident)"
curl -s -o /dev/null -m 10 -X POST "$SRC" -H 'content-type: application/json' \
  -d '{"id":"evt_bad","type":"payment_intent.payment_failed","data":{"object":{"id":"pi_bad","amount":4200}}}'
for i in $(seq 1 40); do
  x=$(api "http://localhost:5678/api/v1/executions?workflowId=$F1&limit=1" | python3 -c "
import sys,json;d=json.load(sys.stdin).get('data',[])
print(d[0]['status'] if d and int(d[0]['id'])>$B1 and d[0].get('stoppedAt') else '')" 2>/dev/null)
  [ -n "$x" ] && break; sleep 1
done
T_F1=$(( $(date +%s) - TS )); echo "  [+${T_F1}s]  flow1 failed (sync 5xx): $x"

AG=""
for i in $(seq 1 120); do
  AG=$(api "http://localhost:5678/api/v1/executions?workflowId=$F2&limit=1" | python3 -c "
import sys,json;d=json.load(sys.stdin).get('data',[])
print(f\"{d[0]['id']}:{d[0]['status']}\" if d and int(d[0]['id'])>$B2 and d[0].get('stoppedAt') else '')" 2>/dev/null)
  [ -n "$AG" ] && break; sleep 1
done
T_AG=$(( $(date +%s) - TS ))
echo "  [+${T_AG}s]  agent finished: ${AG:-TIMEOUT}"
PAUSED=$(hookdeck gateway connection list --output json | python3 -c "
import sys,json;d=json.load(sys.stdin);m=d.get('models',d) if isinstance(d,dict) else d
print([bool(c.get('paused_at')) for c in m if c.get('source',{}).get('name')=='demo-stripe'][0])")
echo "  connection paused by agent: $PAUSED"
echo "  TOTALS: happy=${T_OK}s  fail->agent=${T_AG}s"
