#!/bin/bash
# Auto-cleanup script: removes old temporary files and restarts if disk usage > 85%

set -e

MOOD_CHECKER_DIR="/opt/mood-checker"
DISK_THRESHOLD=85
LOG_FILE="/var/log/mood-checker-cleanup.log"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"
}

log "=== Disk Cleanup Started ==="

# Check current disk usage
DISK_USAGE=$(df / | awk 'NR==2 {print $5}' | sed 's/%//')
log "Current disk usage: ${DISK_USAGE}%"

# Clean old worker snapshots (keep last 30 days)
log "Cleaning worker snapshots older than 30 days..."
find "$MOOD_CHECKER_DIR/public/_worker-snaps" -type f -mtime +30 -delete 2>/dev/null || true
SNAPS_COUNT=$(find "$MOOD_CHECKER_DIR/public/_worker-snaps" -type f 2>/dev/null | wc -l)
log "Remaining worker snapshots: $SNAPS_COUNT"

# Clean old worker live previews (keep last 7 days)
log "Cleaning worker live previews older than 7 days..."
find "$MOOD_CHECKER_DIR/public/_worker-live" -type f -mtime +7 -delete 2>/dev/null || true
LIVE_COUNT=$(find "$MOOD_CHECKER_DIR/public/_worker-live" -type f 2>/dev/null | wc -l)
log "Remaining live previews: $LIVE_COUNT"

# Clean old phantom rejects (keep last 14 days)
log "Cleaning phantom rejects older than 14 days..."
find "$MOOD_CHECKER_DIR/public/_phantom-rejects" -type f -mtime +14 -delete 2>/dev/null || true
PHANTOM_COUNT=$(find "$MOOD_CHECKER_DIR/public/_phantom-rejects" -type f 2>/dev/null | wc -l)
log "Remaining phantom rejects: $PHANTOM_COUNT"

# Aggressively clean old face images if disk still high (keep last 60 days)
DISK_USAGE_AFTER=$(df / | awk 'NR==2 {print $5}' | sed 's/%//')
if [ "$DISK_USAGE_AFTER" -gt 80 ]; then
  log "Disk still high ($DISK_USAGE_AFTER%). Cleaning old face images..."
  find "$MOOD_CHECKER_DIR/public/_faces" -type f -mtime +60 -delete 2>/dev/null || true
  FACES_COUNT=$(find "$MOOD_CHECKER_DIR/public/_faces" -type f 2>/dev/null | wc -l)
  log "Remaining face images: $FACES_COUNT"
fi

# Flush PM2 logs
log "Flushing PM2 logs..."
pm2 flush 2>/dev/null || true

# Final disk check
DISK_USAGE_FINAL=$(df / | awk 'NR==2 {print $5}' | sed 's/%//')
FREE_SPACE=$(df / | awk 'NR==2 {print $4}')
log "Final disk usage: ${DISK_USAGE_FINAL}% (${FREE_SPACE}K free)"

# Only restart if disk is critically full (>95%) - restarting doesn't free disk space
if [ "$DISK_USAGE_FINAL" -gt 95 ]; then
  log "🔴 CRITICAL: Disk ${DISK_USAGE_FINAL}% - cleaning .next/cache..."
  rm -rf /opt/mood-checker/.next/cache 2>/dev/null || true
  DISK_USAGE_FINAL=$(df / | awk 'NR==2 {print $5}' | sed 's/%//')
  FREE_SPACE=$(df / | awk 'NR==2 {print $4}')
  log "After cache clean: ${DISK_USAGE_FINAL}% (${FREE_SPACE}K free)"
elif [ "$DISK_USAGE_FINAL" -gt "$DISK_THRESHOLD" ]; then
  log "⚠️  ALERT: Disk usage ${DISK_USAGE_FINAL}% exceeds threshold ${DISK_THRESHOLD}%. Monitor required."
else
  log "✓ Disk cleanup successful. Disk usage: ${DISK_USAGE_FINAL}%"
fi

log "=== Disk Cleanup Completed ==="
