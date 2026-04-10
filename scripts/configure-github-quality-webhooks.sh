#!/usr/bin/env bash
set -euo pipefail

if ! command -v gh >/dev/null 2>&1; then
  echo "gh CLI is required" >&2
  exit 1
fi

WEBHOOK_URL="${WEBHOOK_URL:-}"
WEBHOOK_SECRET="${WEBHOOK_SECRET:-}"
REPOS_CSV="${REPOS_CSV:-speedscale/microsvc,speedscale/demo}"
EVENTS_CSV="${EVENTS_CSV:-pull_request}"

if [[ -z "$WEBHOOK_URL" ]]; then
  echo "Set WEBHOOK_URL (for example https://agent-factory.example.com/webhooks/github/pulls)" >&2
  exit 1
fi

if [[ -z "$WEBHOOK_SECRET" ]]; then
  echo "Set WEBHOOK_SECRET to match GITHUB_WEBHOOK_SECRET in intake-api" >&2
  exit 1
fi

IFS=',' read -r -a REPOS <<<"$REPOS_CSV"
IFS=',' read -r -a EVENTS <<<"$EVENTS_CSV"

for repo in "${REPOS[@]}"; do
  repo_trimmed="$(echo "$repo" | xargs)"
  if [[ -z "$repo_trimmed" ]]; then
    continue
  fi

  echo "Configuring webhook for $repo_trimmed"

  hook_id="$(gh api "repos/$repo_trimmed/hooks" --jq ".[] | select(.config.url == \"$WEBHOOK_URL\") | .id" || true)"

  api_args=(
    -f active=true
    -f config[url]="$WEBHOOK_URL"
    -f config[content_type]="json"
    -f config[insecure_ssl]="0"
    -f config[secret]="$WEBHOOK_SECRET"
  )

  for event in "${EVENTS[@]}"; do
    event_trimmed="$(echo "$event" | xargs)"
    if [[ -n "$event_trimmed" ]]; then
      api_args+=( -f "events[]=$event_trimmed" )
    fi
  done

  if [[ -n "$hook_id" ]]; then
    gh api --method PATCH "repos/$repo_trimmed/hooks/$hook_id" "${api_args[@]}" >/dev/null
    echo "  updated existing webhook id=$hook_id"
  else
    gh api --method POST "repos/$repo_trimmed/hooks" "${api_args[@]}" >/dev/null
    echo "  created new webhook"
  fi
done

echo "Done. Webhooks now point to $WEBHOOK_URL"
