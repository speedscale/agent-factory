#!/usr/bin/env bash
# radar-traffic-monitor.sh — continuous radar performance monitoring via traffic-scan.
#
# Two-phase operation per run:
#
#   Phase 0 (fast-path): pull the last FAST_PATH_WINDOW_MINUTES of traffic,
#     run Pass 1 only.  If any critical signal is found (errorRate ≥ 50% or
#     p95 ≥ 5000ms), immediately run Pass 2 for those signals and file tickets
#     without waiting for the full window.
#
#   Phase 1 (main scan): pull the last WINDOW_MINUTES of traffic, run full
#     Pass 1 + Pass 2 + ticket creation.
#
#   Phase 2 (verify loop): query Linear for recently-closed radar tickets,
#     run traffic-scan verify-closed against the main snapshot.
#     Tickets whose signal is gone get a "✓ verified" comment; tickets whose
#     signal persists are reopened.
#
# Supports multiple services via PROXYMOCK_SERVICES (comma-separated).
# Each service gets an independent scan with its own baseline directory.
#
# Designed to run from a k8s CronJob every 30 minutes:
#
#   speedstack/instances/agent-factory/do-nyc1-staging-decoy/radar-monitor-cronjob.yaml
#
# Or locally via cron:
#   */30 * * * * /path/to/radar-traffic-monitor.sh >> /var/log/radar-monitor.log 2>&1
#
# Required environment variables:
#   LINEAR_API_KEY      Linear API key with issue-create permission
#   LINEAR_TEAM_ID      Linear team ID to file tickets against
#
# Optional environment variables:
#   LINEAR_LABEL_IDS    Comma-separated label IDs (radar + ai-ready).
#                       NOTE: do NOT include the auto-fix label here. Radar
#                       tickets get triaged by the radar agent first; only the
#                       radar agent (or a human) promotes a ticket to auto-fix
#                       once it's confirmed as a real bug ready for agent-factory.
#   RADAR_REPO_DIR      Path to radar source for code-locus hints
#                       Default: ~/go/src/gitlab.com/speedscale/gtm/radar
#   AF_REPO_DIR         Path to agent-factory repo (for dist/bin/traffic-scan.js)
#                       Default: ~/go/src/github.com/speedscale/agent-factory
#   PROXYMOCK_SERVICES  Comma-separated service names. Default: radar
#   WINDOW_MINUTES      Minutes of traffic to pull per run. Default: 35
#   LOOKBACK_MINUTES    How many minutes ago the window ends (for capture lag).
#                       Default: 5
#   FAST_PATH_WINDOW_MINUTES  Minutes for the critical fast-path pre-scan.
#                       Default: 5
#   MIN_SEVERITY        high|medium|low. Default: medium
#   MAX_TICKETS         Cap on tickets created per run (per service). Default: 5
#   DEDUP_WINDOW_DAYS   Skip signals filed within this many days. Default: 7
#   SNAPSHOT_KEEP_DAYS  Delete local snapshots older than this. Default: 2
#   BASELINE_DIR        Directory for rolling baseline files.
#                       Default: SNAPSHOT_BASE/.baseline
#   RADAR_ARCHIVE_BUCKET  S3-compatible bucket for durable bug-traffic archive.
#                       When set, a bug's snapshot is tarred + uploaded so it
#                       survives deletion of the BYOC/cloud source; the ticket's
#                       Replay line points at it. Unset = archive disabled.
#   RADAR_ARCHIVE_ENDPOINT / _REGION / _ACCESS_KEY_ID / _SECRET_ACCESS_KEY
#                       S3 endpoint + creds (from the radar-archive-s3 secret).
#                       Works with DO Spaces today and AWS S3 unchanged.
#   DRY_RUN             Set to "true" to skip ticket creation (analysis only)
#   VERIFY_WITHIN_DAYS  Check tickets closed within this many days. Default: 2

set -euo pipefail

# ── Config ────────────────────────────────────────────────────────────────────

RADAR_REPO_DIR="${RADAR_REPO_DIR:-$HOME/go/src/gitlab.com/speedscale/gtm/radar}"
AF_REPO_DIR="${AF_REPO_DIR:-$HOME/go/src/github.com/speedscale/agent-factory}"
PROXYMOCK_SERVICES="${PROXYMOCK_SERVICES:-radar}"
WINDOW_MINUTES="${WINDOW_MINUTES:-35}"
LOOKBACK_MINUTES="${LOOKBACK_MINUTES:-5}"
FAST_PATH_WINDOW_MINUTES="${FAST_PATH_WINDOW_MINUTES:-5}"
MIN_SEVERITY="${MIN_SEVERITY:-medium}"
MAX_TICKETS="${MAX_TICKETS:-5}"
DEDUP_WINDOW_DAYS="${DEDUP_WINDOW_DAYS:-7}"
SNAPSHOT_KEEP_DAYS="${SNAPSHOT_KEEP_DAYS:-2}"
VERIFY_WITHIN_DAYS="${VERIFY_WITHIN_DAYS:-2}"
DRY_RUN="${DRY_RUN:-false}"
NO_LLM="${NO_LLM:-false}"
SPEEDSCALE_APP_URL="${SPEEDSCALE_APP_URL:-staging.speedscale.com}"

SNAPSHOT_BASE="${TMPDIR:-/tmp}/radar-monitor-snapshots"
BASELINE_DIR="${BASELINE_DIR:-$SNAPSHOT_BASE/.baseline}"
LOG_PREFIX="[radar-monitor $(date -u +%Y-%m-%dT%H:%M:%SZ)]"

# ── Validate ──────────────────────────────────────────────────────────────────

if [[ "$DRY_RUN" != "true" ]]; then
  if [[ -z "${LINEAR_API_KEY:-}" ]]; then
    echo "$LOG_PREFIX ERROR: LINEAR_API_KEY is not set (use DRY_RUN=true to skip ticket creation)" >&2
    exit 1
  fi
  if [[ -z "${LINEAR_TEAM_ID:-}" ]]; then
    echo "$LOG_PREFIX ERROR: LINEAR_TEAM_ID is not set" >&2
    exit 1
  fi
fi

# ANTHROPIC_API_KEY is only required when NO_LLM is not set
if [[ "${NO_LLM:-false}" != "true" ]]; then
  if [[ -z "${ANTHROPIC_API_KEY:-}" ]]; then
    echo "$LOG_PREFIX WARNING: ANTHROPIC_API_KEY not set; LLM calls will fail (set NO_LLM=true to skip)" >&2
  fi
fi

if [[ ! -f "$AF_REPO_DIR/dist/bin/traffic-scan.js" ]]; then
  echo "$LOG_PREFIX ERROR: agent-factory not built at $AF_REPO_DIR/dist/bin/traffic-scan.js" >&2
  echo "$LOG_PREFIX Run: cd $AF_REPO_DIR && npm run build" >&2
  exit 1
fi

# speedctl reads auth from ~/.speedscale/config.yaml (not $SPEEDSCALE_API_KEY).
# Bootstrap it if the config is missing (first run in a new pod).
if [[ ! -f "${HOME}/.speedscale/config.yaml" && -n "${SPEEDSCALE_API_KEY:-}" ]]; then
  echo "$LOG_PREFIX Initializing speedctl config"
  speedctl init \
    --api-key "${SPEEDSCALE_API_KEY}" \
    --app-url "${SPEEDSCALE_APP_URL}" \
    --yes --quiet 2>&1 || \
    echo "$LOG_PREFIX WARNING: speedctl init failed — snapshot pulls may not work" >&2
fi

mkdir -p "$BASELINE_DIR"

# ── Time window helpers ───────────────────────────────────────────────────────

date_minus_minutes() {
  local minutes="$1"
  date -u -v-${minutes}M +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
    || date -u -d "${minutes} minutes ago" +%Y-%m-%dT%H:%M:%SZ
}

# ── Cloud snapshot retention helpers ──────────────────────────────────────────
# Snapshots are normally ephemeral (deleted right after the pull). But when a
# scan files a ticket we KEEP the snapshot so the bug stays replayable — the
# ticket carries `proxymock cloud pull snapshot <id>`. LAST_SNAP_ID is set by
# pull_snapshot so the caller can pass it to the scan and decide keep-vs-delete.
LAST_SNAP_ID=""

delete_cloud_snapshot() {
  local id="$1" lp="${2:-[snapshot]}"
  [[ -z "$id" ]] && return 0
  speedctl delete snapshot "$id" --exit-zero >/dev/null 2>&1 \
    && echo "$lp Deleted cloud snapshot $id"
}

# settle_snapshot <tickets_created> <snap_id> <local_dir> <log_prefix>
# Decide what happens to a snapshot once the scan result is known:
#   - bug filed + archive bucket configured → tar the pulled dir and upload it
#     to the factory's durable bucket (survives BYOC/source deletion), then
#     drop the ephemeral cloud snapshot. The ticket's Replay line points at the
#     bucket copy.
#   - bug filed + NO archive bucket → keep the cloud snapshot as the fallback
#     replay source.
#   - no bug → delete the cloud snapshot.
settle_snapshot() {
  local created="$1" id="$2" dir="$3" lp="${4:-[snapshot]}"
  [[ -z "$id" ]] && return 0
  if [[ ! "$created" =~ ^[0-9]+$ || "$created" -le 0 ]]; then
    delete_cloud_snapshot "$id" "$lp"
    return 0
  fi
  if [[ -n "${RADAR_ARCHIVE_BUCKET:-}" ]]; then
    local tgz="${dir%/}.tgz"
    if tar -czf "$tgz" -C "$dir" . 2>/dev/null; then
      (cd "$AF_REPO_DIR" && node dist/bin/archive-snapshot.js --file "$tgz" --key "radar-monitor/${id}.tgz" 2>&1 | sed "s/^/$lp [archive] /") \
        || echo "$lp WARNING: archive upload failed (non-fatal; ticket still filed)"
      rm -f "$tgz"
    else
      echo "$lp WARNING: could not tar snapshot for archive (non-fatal)"
    fi
    delete_cloud_snapshot "$id" "$lp"   # durable copy now lives in the bucket
  else
    echo "$lp Kept cloud snapshot $id for replay ($created ticket(s) filed; no archive bucket)"
  fi
}

# upload_findings <service> <findings_file> <snap_id> <snap_dir> <log_prefix>
# When findings contain signals, upload the analysis JSON and the snapshot
# tarball to the archive bucket. This replaces Linear ticket creation as the
# durable record of what the factory found.
upload_findings() {
  local service="$1" findings="$2" snap_id="$3" dir="$4" lp="${5:-[findings]}"
  [[ -z "${RADAR_ARCHIVE_BUCKET:-}" ]] && return 0
  [[ ! -f "$findings" ]] && return 0

  local sig_count
  sig_count=$(python3 -c "
import json, sys
with open(sys.argv[1]) as f:
    d = json.load(f)
sigs = d.get('signals', d.get('stats', {}).get('signals', []))
print(len(sigs) if isinstance(sigs, list) else 0)
" "$findings" 2>/dev/null || echo "0")

  if [[ "$sig_count" -le 0 ]]; then
    echo "$lp No signals — skipping bucket upload"
    return 0
  fi

  local ts
  ts=$(date -u +%Y%m%dT%H%M%SZ)
  local findings_key="radar-monitor/findings/${service}-${ts}.json"
  echo "$lp Uploading findings ($sig_count signals) to s3://${RADAR_ARCHIVE_BUCKET}/${findings_key}"
  (cd "$AF_REPO_DIR" && node dist/bin/archive-snapshot.js --file "$findings" --key "$findings_key" 2>&1 | sed "s/^/$lp [archive] /") \
    || echo "$lp WARNING: findings upload failed (non-fatal)"

  if [[ -n "$snap_id" && -d "$dir" ]]; then
    local tgz="${dir%/}.tgz"
    if tar -czf "$tgz" -C "$dir" . 2>/dev/null; then
      echo "$lp Archiving snapshot $snap_id for replay"
      (cd "$AF_REPO_DIR" && node dist/bin/archive-snapshot.js --file "$tgz" --key "radar-monitor/snapshots/${snap_id}.tgz" 2>&1 | sed "s/^/$lp [archive] /") \
        || echo "$lp WARNING: snapshot archive failed (non-fatal)"
      rm -f "$tgz"
    fi
  fi
}

# ── Snapshot pull helper ──────────────────────────────────────────────────────
# pull_snapshot <service> <out_dir> <start_mins_ago> <end_mins_ago> <log_prefix>
# Creates a cloud snapshot for a relative time window and pulls RRPair files.
# Uses speedctl create snapshot + proxymock cloud pull snapshot <id>.
# Sets LAST_SNAP_ID to the created snapshot's ID (does NOT delete it — the
# caller decides via keep_or_delete_snapshot once the scan result is known).
pull_snapshot() {
  local service="$1"
  local out_dir="$2"
  local start_mins="$3"   # how many minutes ago the window starts
  local end_mins="$4"     # how many minutes ago the window ends (0 = now)
  local log_prefix="${5:-[pull_snapshot]}"
  local snap_name="radar-monitor-${service}-$(date -u +%Y%m%d-%H%M%S)"
  LAST_SNAP_ID=""

  local snap_json snap_id
  snap_json=$(speedctl create snapshot \
    --service "$service" \
    --start "${start_mins}m" \
    --end "${end_mins}m" \
    --name "$snap_name" \
    --output json 2>&1) || {
    echo "$log_prefix ERROR: speedctl create snapshot failed: $snap_json"
    return 1
  }
  snap_id=$(echo "$snap_json" | python3 -c \
    "import json,sys; d=json.load(sys.stdin); print(d['snapshot']['id'])" 2>/dev/null || echo "")
  if [[ -z "$snap_id" ]]; then
    echo "$log_prefix ERROR: could not extract snapshot ID from response"
    return 1
  fi
  LAST_SNAP_ID="$snap_id"

  echo "$log_prefix Waiting for snapshot $snap_id to be ready (timeout 5m)"
  speedctl wait snapshot "$snap_id" --timeout 5m 2>&1 \
    | sed "s/^/$log_prefix [speedctl] /" || {
    echo "$log_prefix ERROR: snapshot $snap_id did not become ready in time"
    delete_cloud_snapshot "$snap_id" "$log_prefix"   # never-ready snapshot is useless
    LAST_SNAP_ID=""
    return 1
  }

  # Pull RRPairs to local disk. We do NOT delete the snapshot here anymore —
  # the caller keeps it if the scan files a ticket, else deletes it via
  # keep_or_delete_snapshot. pull_rc captures pipe failure (set -e safe).
  echo "$log_prefix Pulling snapshot $snap_id"
  local pull_rc=0
  proxymock cloud pull snapshot "$snap_id" --out "$out_dir" 2>&1 \
    | grep -v $'\r' \
    | sed "s/^/$log_prefix [proxymock] /" || pull_rc=$?
  return $pull_rc
}

# ── traffic-scan runner ───────────────────────────────────────────────────────

run_traffic_scan() {
  local service="$1"
  local snapshot_dir="$2"
  local extra_args="${3:-}"
  local snapshot_id="${4:-}"
  local repo_arg=""

  if [[ -d "$RADAR_REPO_DIR" && "$service" == "radar" ]]; then
    repo_arg="--repo '$RADAR_REPO_DIR'"
  fi

  local snapid_arg=""
  if [[ -n "$snapshot_id" ]]; then
    snapid_arg="--snapshot-id $snapshot_id"
  fi

  local create_arg=""
  if [[ "$DRY_RUN" != "true" ]]; then
    create_arg="--create-tickets"
  fi

  local nollm_arg=""
  if [[ "${NO_LLM:-false}" == "true" ]]; then
    nollm_arg="--no-llm"
  fi

  (
    cd "$AF_REPO_DIR" && \
    LINEAR_API_KEY="${LINEAR_API_KEY:-}" \
    LINEAR_TEAM_ID="${LINEAR_TEAM_ID:-}" \
    LINEAR_LABEL_IDS="${LINEAR_LABEL_IDS:-}" \
    BASELINE_DIR="$BASELINE_DIR" \
    node dist/bin/traffic-scan.js \
      --snapshot "$snapshot_dir" \
      --service "$service" \
      --baseline-dir "$BASELINE_DIR" \
      --min-severity "$MIN_SEVERITY" \
      --max-tickets "$MAX_TICKETS" \
      --dedup-window "$DEDUP_WINDOW_DAYS" \
      $repo_arg \
      $create_arg \
      $nollm_arg \
      $snapid_arg \
      $extra_args \
      2>&1
  )
}

# ── Per-service scan ──────────────────────────────────────────────────────────

scan_service() {
  local service="$1"
  local svc_log="[radar-monitor:$service $(date -u +%H:%M:%SZ)]"

  echo "$svc_log Starting scan"

  local window_end window_start fast_end fast_start
  window_end=$(date_minus_minutes "$LOOKBACK_MINUTES")
  window_start=$(date_minus_minutes "$WINDOW_MINUTES")
  fast_end=$(date_minus_minutes "$LOOKBACK_MINUTES")
  fast_start=$(date_minus_minutes "$((LOOKBACK_MINUTES + FAST_PATH_WINDOW_MINUTES))")

  local run_ts snapshot_dir fast_dir
  run_ts=$(date -u +%Y-%m-%d_%H-%M-%S)
  snapshot_dir="$SNAPSHOT_BASE/${service}-${run_ts}"
  fast_dir="$SNAPSHOT_BASE/${service}-fast-${run_ts}"
  mkdir -p "$snapshot_dir" "$fast_dir"

  # ── Phase 0: fast-path pre-scan (Pass 1 only, last 5 min) ─────────────────
  echo "$svc_log Phase 0: fast-path ($fast_start → $fast_end)"
  pull_snapshot "$service" "$fast_dir" \
    "$((LOOKBACK_MINUTES + FAST_PATH_WINDOW_MINUTES))" \
    "$LOOKBACK_MINUTES" \
    "$svc_log" 2>&1 || true
  local fast_snap_id="$LAST_SNAP_ID"

  if [[ -n "$(find "$fast_dir" \( -name '*.json' -o -name '*.md' \) 2>/dev/null | head -1)" ]]; then
    local fast_findings="$SNAPSHOT_BASE/${service}-fast-${run_ts}-findings.json"
    FAST_OUTPUT=$(run_traffic_scan "$service" "$fast_dir" "--min-severity high --max-tickets 3 --no-correlate --output $fast_findings" "$fast_snap_id" 2>&1)
    echo "$FAST_OUTPUT" | sed "s/^/$svc_log [fast] /"

    FAST_CREATED=$(echo "$FAST_OUTPUT" | grep '"phase":"summary"' | python3 -c \
      "import json,sys; d=json.load(sys.stdin); print(d.get('created',0))" 2>/dev/null || echo "0")
    if [[ "$FAST_CREATED" -gt 0 ]]; then
      echo "$svc_log Fast-path filed $FAST_CREATED critical ticket(s)"
    fi
    upload_findings "$service" "$fast_findings" "$fast_snap_id" "$fast_dir" "$svc_log"
    settle_snapshot "$FAST_CREATED" "$fast_snap_id" "$fast_dir" "$svc_log"
  else
    echo "$svc_log Fast-path: no recent traffic"
    delete_cloud_snapshot "$fast_snap_id" "$svc_log"
  fi

  # ── Phase 1: main full-window scan ─────────────────────────────────────────
  echo "$svc_log Phase 1: main scan ($window_start → $window_end)"
  pull_snapshot "$service" "$snapshot_dir" \
    "$WINDOW_MINUTES" \
    "$LOOKBACK_MINUTES" \
    "$svc_log" 2>&1 || true
  local main_snap_id="$LAST_SNAP_ID"

  if [[ -z "$(find "$snapshot_dir" \( -name '*.json' -o -name '*.md' \) 2>/dev/null | head -1)" ]]; then
    echo "$svc_log WARNING: main snapshot empty — skipping scan"
    delete_cloud_snapshot "$main_snap_id" "$svc_log"
    return 0
  fi

  local rrpair_count
  rrpair_count=$(find "$snapshot_dir" \( -name '*.json' -o -name '*.md' \) ! -path '*/.metadata/*' | wc -l | tr -d ' ')
  echo "$svc_log Pulled $rrpair_count RRPair files"

  local main_findings="$SNAPSHOT_BASE/${service}-${run_ts}-findings.json"
  OUTPUT=$(run_traffic_scan "$service" "$snapshot_dir" "--output $main_findings" "$main_snap_id" 2>&1)
  echo "$OUTPUT" | sed "s/^/$svc_log /"

  CREATED=$(echo "$OUTPUT" | grep '"phase":"summary"' | python3 -c \
    "import json,sys; d=json.load(sys.stdin); print(d.get('created',0))" 2>/dev/null || echo "?")
  SKIPPED=$(echo "$OUTPUT" | grep '"phase":"summary"' | python3 -c \
    "import json,sys; d=json.load(sys.stdin); print(d.get('skipped',0))" 2>/dev/null || echo "?")
  echo "$svc_log Main scan done. Tickets created: $CREATED, skipped: $SKIPPED"

  upload_findings "$service" "$main_findings" "$main_snap_id" "$snapshot_dir" "$svc_log"
  settle_snapshot "$CREATED" "$main_snap_id" "$snapshot_dir" "$svc_log"

  # ── Phase 2: verify loop (check recently-closed tickets) ──────────────────
  if [[ "$DRY_RUN" != "true" && -n "${LINEAR_API_KEY:-}" ]]; then
    echo "$svc_log Phase 2: verify loop (closed within ${VERIFY_WITHIN_DAYS}d)"
    VERIFY_OUTPUT=$(
      cd "$AF_REPO_DIR" && \
      node dist/bin/traffic-scan.js verify-closed-batch \
        --snapshot "$snapshot_dir" \
        --within-days "$VERIFY_WITHIN_DAYS" \
        2>&1
    )
    echo "$VERIFY_OUTPUT" | sed "s/^/$svc_log [verify] /"
  fi
}

# ── Main loop ─────────────────────────────────────────────────────────────────

echo "$LOG_PREFIX Starting — services: $PROXYMOCK_SERVICES"

IFS=',' read -ra SERVICES <<< "$PROXYMOCK_SERVICES"
for service in "${SERVICES[@]}"; do
  service="${service// /}"  # trim spaces
  [[ -z "$service" ]] && continue
  scan_service "$service" || echo "$LOG_PREFIX ERROR: scan_service $service failed (exit $?)" >&2
done

# ── Cleanup old snapshots ─────────────────────────────────────────────────────

find "$SNAPSHOT_BASE" -maxdepth 1 -type d -mtime +${SNAPSHOT_KEEP_DAYS} -exec rm -rf {} + 2>/dev/null || true

echo "$LOG_PREFIX Done."
