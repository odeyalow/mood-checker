#!/bin/bash
# Healthcheck script: verifies worker is alive and restarts if stuck

set -e

API_BASE="http://127.0.0.1:3000"
LOG_FILE="/var/log/mood-checker-healthcheck.log"
STATE_FILE="/tmp/mood-checker-health-state.json"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"
}

log "=== Healthcheck Started ==="

# Get current status with retry (processes might be restarting)
STATUS=""
for i in {1..3}; do
  STATUS=$(curl -s --max-time 2 "$API_BASE/api/worker/status" 2>/dev/null || echo "{}")
  LAST_FRAME_AT=$(echo "$STATUS" | grep -o '"lastFrameAt":"[^"]*"' | cut -d'"' -f4 || echo "")
  
  if [ -n "$LAST_FRAME_AT" ]; then
    log "✓ Got worker status on attempt $i"
    break
  fi
  
  if [ $i -lt 3 ]; then
    log "⚠️  Retry $i/3: Could not fetch worker status, waiting 2s..."
    sleep 2
  fi
done

if [ -z "$LAST_FRAME_AT" ]; then
  log "⚠️  WARNING: Could not fetch worker status after 3 retries"
  log "Checking if processes are running..."
  WORKER_STATUS=$(pm2 list | grep mood-checker-worker | awk '{print $9}')
  
  if [ "$WORKER_STATUS" = "online" ]; then
    log "✓ Worker process is online, might just be slow startup"
  else
    log "🔴 Worker process is not online. Restarting..."
    pm2 restart mood-checker-worker --update-env
    sleep 5
  fi
  exit 0
fi

# Convert lastFrameAt to unix timestamp
LAST_FRAME_UNIX=$(date -d "$LAST_FRAME_AT" +%s 2>/dev/null || echo 0)
NOW_UNIX=$(date +%s)
SECONDS_SINCE_FRAME=$((NOW_UNIX - LAST_FRAME_UNIX))

log "Last frame: $LAST_FRAME_AT (${SECONDS_SINCE_FRAME}s ago)"

# Load previous state
if [ -f "$STATE_FILE" ]; then
  PREV_FRAME_AT=$(grep -o '"lastFrameAt":"[^"]*"' "$STATE_FILE" | cut -d'"' -f4 || echo "")
  STUCK_COUNT=$(grep -o '"stuckCount":[0-9]*' "$STATE_FILE" | cut -d':' -f2 || echo 0)
else
  PREV_FRAME_AT=""
  STUCK_COUNT=0
fi

# Check if worker is stuck (not processing frames)
if [ "$LAST_FRAME_AT" = "$PREV_FRAME_AT" ] && [ "$SECONDS_SINCE_FRAME" -gt 30 ]; then
  STUCK_COUNT=$((STUCK_COUNT + 1))
  log "⚠️  Worker appears stuck (${STUCK_COUNT} consecutive checks). lastFrame unchanged for ${SECONDS_SINCE_FRAME}s"
  
  if [ "$STUCK_COUNT" -ge 3 ]; then
    log "🔴 CRITICAL: Worker stuck for 3+ checks. Restarting..."
    pm2 restart mood-checker-worker --update-env
    STUCK_COUNT=0
    sleep 5
    log "Worker restarted"
  fi
else
  STUCK_COUNT=0
  log "✓ Worker is processing frames normally"
fi

# Check for database errors in logs
DB_ERRORS=$(pm2 logs mood-checker-app --lines 50 --nostream 2>/dev/null | grep -i "database or disk is full" | wc -l || echo 0)
if [ "$DB_ERRORS" -gt 0 ]; then
  log "🔴 CRITICAL: Database disk full errors detected"
  log "Running disk cleanup..."
  bash /opt/mood-checker/scripts/cleanup-disk.sh || true
fi

# Check process memory usage
WORKER_MEM=$(ps aux | grep "node-detection-worker.mjs" | grep -v grep | awk '{print $6}' || echo 0)
if [ "$WORKER_MEM" -gt 1000000 ]; then
  log "⚠️  WARNING: Worker using ${WORKER_MEM}KB memory (>1GB). Consider restarting..."
  if [ "$WORKER_MEM" -gt 1500000 ]; then
    log "Worker memory critical (>1.5GB). Restarting..."
    pm2 restart mood-checker-worker --update-env
    sleep 3
  fi
fi

# Save current state
cat > "$STATE_FILE" << EOF
{
  "lastFrameAt": "$LAST_FRAME_AT",
  "stuckCount": $STUCK_COUNT,
  "checkedAt": "$(date -Iseconds)"
}
EOF

log "=== Healthcheck Completed ==="
