#!/usr/bin/env bash
set -euo pipefail

echo "configure-github-issue-webhooks.sh is deprecated; forwarding to configure-github-quality-webhooks.sh" >&2
exec "$(dirname "$0")/configure-github-quality-webhooks.sh"
