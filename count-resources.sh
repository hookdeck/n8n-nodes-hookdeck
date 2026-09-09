#!/bin/bash
# Count resources in the test project, so a live run's leakage is measurable.
set -a
. ./.env
set +a
node --input-type=module -e '
const key = process.env.HOOKDECK_EG_API_KEY;
const base = "https://api.hookdeck.com/2025-07-01";
const get = async (kind) => {
  const r = await fetch(`${base}/${kind}?limit=250`, { headers: { Authorization: `Bearer ${key}` } });
  const { models = [] } = await r.json();
  return models;
};
for (const kind of ["sources", "destinations", "connections"]) {
  const models = await get(kind);
  const node = models.filter((m) => (m.name ?? "").startsWith("n8n"));
  console.log(`${kind.padEnd(13)} total=${String(models.length).padStart(3)}  n8n-named=${String(node.length).padStart(3)}`);
}
'
