#!/usr/bin/env bash
# Fail if any code in src/ silently defaults to the Anthropic provider.
#
# Rule (per AGENTS.md): agents and engine entry points must resolve the LLM
# provider via resolveEngineConfig(env). A `?? "anthropic"` fallback would
# mask a misconfigured BYOC deployment — the operator believed they'd cut
# over to a local model and quietly hit the public API instead.
#
# The single legitimate occurrence is in src/lib/engine-config.ts itself,
# which maps the chart-aligned "claude-sdk" engine kind to the internal
# "anthropic" provider. That mapping is the resolver's whole job.

set -euo pipefail

cd "$(dirname "$0")/.."

# grep returns 1 on no-match; the trailing `|| true` keeps the script
# alive long enough to inspect the result.
matches=$(grep -RnE '\?\?\s*"anthropic"' src/ --include='*.ts' || true)

# Allow exactly the resolver itself.
filtered=$(printf '%s\n' "$matches" | grep -v '^$' | grep -v '^src/lib/engine-config\.ts:' || true)

if [ -n "$filtered" ]; then
  echo 'check:no-anthropic-default — found `?? "anthropic"` fallbacks in src/ outside engine-config.ts:'
  echo
  printf '%s\n' "$filtered"
  echo
  echo 'Resolve the provider via `resolveEngineConfig(env)` instead. See AGENTS.md → Core rules.'
  exit 1
fi

echo 'check:no-anthropic-default — clean.'
