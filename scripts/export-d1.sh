#!/usr/bin/env bash
# Export all D1 outline + plugin side-data to a JSON file (PRD Phase 4 / US-5).
# Run once before decommissioning Cloudflare D1. Requires `wrangler login`.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONFIG="$ROOT/cloudflare-legacy/wrangler.export.jsonc"
D1_CONFIG="$ROOT/cloudflare-legacy/d1-config.json"
DB="dotflowy-db"
OUT="${1:-$ROOT/backups/d1-export-$(date +%Y%m%d-%H%M%S).json}"

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required (brew install jq)" >&2
  exit 1
fi

mkdir -p "$(dirname "$OUT")"

run_sql() {
  npx --yes wrangler d1 execute "$DB" --remote --config "$CONFIG" \
    --command "$1" --json
}

rows() {
  run_sql "$1" | jq -c '.[0].results // []'
}

DATABASE_ID="$(jq -r '.database_id' "$D1_CONFIG")"
EXPORTED_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

owners_json="$(rows "SELECT DISTINCT owner FROM nodes ORDER BY owner")"
if [ "$(echo "$owners_json" | jq 'length')" -eq 0 ]; then
  owners_json="$(rows "SELECT DISTINCT owner FROM kv ORDER BY owner")"
fi

owners_obj="{}"
while IFS= read -r owner; do
  [ -z "$owner" ] && continue
  owner_esc="${owner//\"/\\\"}"

  nodes="$(rows "SELECT id, owner, parentId, prevSiblingId, text, isTask, completed, collapsed, bookmarkedAt, createdAt, updatedAt FROM nodes WHERE owner = \"$owner_esc\" ORDER BY createdAt")"

  tag_colors="$(rows "SELECT value FROM kv WHERE owner = \"$owner_esc\" AND collection = 'tag-colors'" | jq '[.[].value | fromjson]')"
  daily_index="$(rows "SELECT value FROM kv WHERE owner = \"$owner_esc\" AND collection = 'daily-index'" | jq '[.[].value | fromjson]')"

  owners_obj="$(jq -n \
    --argjson base "$owners_obj" \
    --arg owner "$owner" \
    --argjson nodes "$nodes" \
    --argjson tagColors "$tag_colors" \
    --argjson dailyIndex "$daily_index" \
    '$base + { ($owner): { nodes: $nodes, tagColors: $tagColors, dailyIndex: $dailyIndex } }')"
done < <(echo "$owners_json" | jq -r '.[].owner // empty')

jq -n \
  --arg version "1" \
  --arg exportedAt "$EXPORTED_AT" \
  --arg databaseId "$DATABASE_ID" \
  --argjson owners "$owners_obj" \
  '{ version: ($version | tonumber), exportedAt: $exportedAt, databaseId: $databaseId, owners: $owners }' \
  > "$OUT"

node_count="$(jq '[.owners[].nodes | length] | add // 0' "$OUT")"
echo "Wrote $OUT ($node_count nodes across $(jq '.owners | keys | length' "$OUT") owner(s))"
