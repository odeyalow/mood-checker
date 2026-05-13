#!/bin/bash
# Healthcheck script for worker stability.

set -euo pipefail

API_BASE="http://127.0.0.1:3000"
LOG_FILE="/var/log/mood-checker-healthcheck.log"
STATE_FILE="/tmp/mood-checker-health-state.json"
CLEANUP_STAMP_FILE="/tmp/mood-checker-last-cleanup-at"
MEM_RESTART_THRESHOLD_KB=600000
STUCK_SECONDS_THRESHOLD=45
STUCK_CHECKS_THRESHOLD=3
CLEANUP_COOLDOWN_SECONDS=1800

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"
}

epoch_now() {
  date +%s
}

can_run_cleanup() {
  local now last
  now=$(epoch_now)
  if [ ! -f "$CLEANUP_STAMP_FILE" ]; then
    echo "$now" > "$CLEANUP_STAMP_FILE"
    return 0
  fi
  last=$(cat "$CLEANUP_STAMP_FILE" 2>/dev/null || echo 0)
  if [ $((now - last)) -ge "$CLEANUP_COOLDOWN_SECONDS" ]; then
    echo "$now" > "$CLEANUP_STAMP_FILE"
    return 0
  fi
  return 1
}

log "=== Healthcheck Started ==="

STATUS=$(curl -s --max-time 2 "$API_BASE/api/worker/status" 2>/dev/null || echo "{}")
LAST_FRAME_AT=$(echo "$STATUS" | grep -o '"lastFrameAt":"[^"]*"' | cut -d'"' -f4 || echo "")

WORKER_PID=$(pgrep -f "node-detection-worker.mjs" || echo "")
WORKER_MEM=$(ps aux | grep "node-detection-worker.mjs" | grep -v grep | awk '{print $6}' || echo 0)

if [ -z "$WORKER_PID" ]; then
  log "CRITICAL: Worker process not found. Restarting worker."
  pm2 restart mood-checker-worker --update-env || true
  log "=== Healthcheck Completed ==="
  exit 0
fi

if [ "$WORKER_MEM" -gt "$MEM_RESTART_THRESHOLD_KB" ]; then
  log "CRITICAL: Worker memory ${WORKER_MEM}KB exceeds ${MEM_RESTART_THRESHOLD_KB}KB. Restarting worker."
  pm2 restart mood-checker-worker --update-env || true
  log "=== Healthcheck Completed ==="
  exit 0
fi

if [ -z "$LAST_FRAME_AT" ]; then
  log "WARN: /api/worker/status not ready. Worker PID=$WORKER_PID MEM=${WORKER_MEM}KB"
else
  LAST_FRAME_UNIX=$(date -d "$LAST_FRAME_AT" +%s 2>/dev/null || echo 0)
  NOW_UNIX=$(epoch_now)
  SECONDS_SINCE_FRAME=$((NOW_UNIX - LAST_FRAME_UNIX))

  PREV_FRAME_AT=""
  STUCK_COUNT=0
  if [ -f "$STATE_FILE" ]; then
    PREV_FRAME_AT=$(grep -o '"lastFrameAt":"[^"]*"' "$STATE_FILE" | cut -d'"' -f4 || echo "")
    STUCK_COUNT=$(grep -o '"stuckCount":[0-9]*' "$STATE_FILE" | cut -d':' -f2 || echo 0)
  fi

  if [ "$LAST_FRAME_AT" = "$PREV_FRAME_AT" ] && [ "$SECONDS_SINCE_FRAME" -gt "$STUCK_SECONDS_THRESHOLD" ]; then
    STUCK_COUNT=$((STUCK_COUNT + 1))
    log "WARN: Worker may be stuck. unchanged=${SECONDS_SINCE_FRAME}s checks=${STUCK_COUNT}/${STUCK_CHECKS_THRESHOLD}"
    if [ "$STUCK_COUNT" -ge "$STUCK_CHECKS_THRESHOLD" ]; then
      log "CRITICAL: Worker stuck for ${STUCK_COUNT} checks. Restarting worker."
      pm2 restart mood-checker-worker --update-env || true
      STUCK_COUNT=0
    fi
  else
    STUCK_COUNT=0
    log "OK: Worker healthy. PID=$WORKER_PID MEM=${WORKER_MEM}KB frame_age=${SECONDS_SINCE_FRAME}s"
  fi

  cat > "$STATE_FILE" << EOF
{
  "lastFrameAt": "$LAST_FRAME_AT",
  "stuckCount": $STUCK_COUNT,
  "checkedAt": "$(date -Iseconds)"
}
EOF
fi

DISK_USAGE=$(df / | awk 'NR==2 {print $5}' | sed 's/%//')
if [ "$DISK_USAGE" -gt 95 ]; then
  if can_run_cleanup; then
    log "WARN: Disk usage ${DISK_USAGE}%. Running cleanup with cooldown."
    bash /opt/mood-checker/scripts/cleanup-disk.sh || true
  else
    log "WARN: Disk usage ${DISK_USAGE}%. Cleanup skipped due to cooldown."
  fi
fi

log "=== Healthcheck Completed ==="
