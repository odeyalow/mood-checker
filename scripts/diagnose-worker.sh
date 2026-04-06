#!/usr/bin/env bash
set -euo pipefail

OUT="/tmp/mood-worker-diagnose-$(date +%F-%H%M%S).log"
APP_NAME="mood-checker-worker"

if ! pm2 describe "${APP_NAME}" >/dev/null 2>&1; then
  APP_NAME="mood-checker-pyworker"
fi

CAMERA_IDS_RAW="$(grep -E '^WORKER_CAMERA_SOURCES=' .env.worker 2>/dev/null | tail -n 1 | cut -d= -f2- || true)"
if [ -n "${CAMERA_IDS_RAW}" ]; then
  mapfile -t CAMERA_IDS < <(printf '%s\n' "${CAMERA_IDS_RAW}" | tr ',' '\n' | cut -d= -f1 | sed '/^$/d')
else
  CAMERA_IDS=("cam-01")
fi

{
  echo "=== TIME ==="
  date -Is

  echo "=== PM2 STATUS ==="
  pm2 status || true
  echo
  echo "=== PM2 SHOW ${APP_NAME} ==="
  pm2 show "${APP_NAME}" || true

  echo
  echo "=== ENV (.env.worker key subset) ==="
  grep -nE \
    "WORKER_(FRAME_TIMEOUT_MS|FRAME_ABORT_RETRY_TIMEOUT_MS|CAMERA_ZOOMS|CAMERA_SETTINGS_JSON|DB_COOLDOWN_MS|DB_REENTRY_GAP_MS|SESSION_|MATCH_|EMOTION_)" \
    .env.worker 2>/dev/null || true

  echo
  echo "=== STATUS API ==="
  for c in "${CAMERA_IDS[@]}"; do
    echo "-- ${c}"
    curl -sS "http://127.0.0.1:3000/api/worker/status?cameraId=${c}" || true
    echo
  done

  echo
  echo "=== ZOOM API ==="
  for c in "${CAMERA_IDS[@]}"; do
    echo "-- ${c}"
    curl -sS "http://127.0.0.1:3000/api/worker/zoom?cameraId=${c}" || true
    echo
  done

  echo
  echo "=== PROFILE / START LINES ==="
  pm2 logs "${APP_NAME}" --lines 300 --nostream 2>/dev/null | \
    egrep -i "camera settings parse error|matching=on|session snapshot_ms|db cooldown_ms|\\[cam-[0-9]{2}\\] profile" || true

  echo
  echo "=== EVENT COUNTS (last 500 lines) ==="
  LOG="$(pm2 logs "${APP_NAME}" --lines 500 --nostream 2>/dev/null || true)"
  for c in "${CAMERA_IDS[@]}"; do
    echo "-- ${c}"
    face_count="$(echo "${LOG}" | grep -c "\\[${c}\\] face_detected" || true)"
    cand_count="$(echo "${LOG}" | grep -c "\\[${c}\\] candidate_detected" || true)"
    match_count="$(echo "${LOG}" | grep -c "\\[${c}\\] matched names=" || true)"
    snap_count="$(echo "${LOG}" | grep -c "\\[${c}\\] snapshot faces=" || true)"
    err_count="$(echo "${LOG}" | grep -c "\\[${c}\\] frame error:" || true)"
    echo "face_detected=${face_count} candidate_detected=${cand_count} matched=${match_count} snapshot=${snap_count} frame_error=${err_count}"
    echo
    echo "${LOG}" | egrep "\\[${c}\\] (candidate_detected|face_detected|matched names=|snapshot faces=|frame error:)" | tail -n 80 || true
    echo
  done
} | tee "${OUT}"

echo "saved: ${OUT}"
