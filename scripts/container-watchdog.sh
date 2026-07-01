#!/bin/bash
#
# NanoClaw Container Watchdog
# ---------------------------
# Runs periodically (via launchd). Two jobs:
#
#   1. CLEANUP   — prune stopped Apple Container VMs and reap orphaned
#                  container-runtime-linux processes so they cannot
#                  accumulate and wedge the apiserver.
#
#   2. RECOVERY  — detect the "stuck spawn" failure mode (every container
#                  spawn times out at startup with no output) and break it
#                  by restarting the Apple Container apiserver and the
#                  nanoclaw orchestrator.
#
# The orchestrator already reaps the runtime for an individual timed-out
# container, but once Apple Container drops into a half-dead state the
# orchestrator alone cannot recover — every subsequent spawn hangs for the
# full startup timeout. This external watchdog restarts the platform from
# the outside, which the orchestrator cannot do for itself.
#
# Safe to run on a healthy system: cleanup never touches running containers
# (the bridge sentinel is preserved), and recovery only fires when a run of
# consecutive startup timeouts with no intervening success is detected.

set -uo pipefail

# --- Configuration ---------------------------------------------------------
PROJECT_DIR="/Users/akiratsunoda/nanoclaw-sandbox-9450"
LOG="$PROJECT_DIR/logs/nanoclaw.log"
WATCHDOG_LOG="$PROJECT_DIR/logs/watchdog.log"
STATE_DIR="$PROJECT_DIR/data/watchdog"
LAST_RECOVERY_FILE="$STATE_DIR/last-recovery"
# Byte offset into $LOG recorded at the moment of the last recovery. is_stuck()
# only inspects log content written AFTER this point, so the timeout lines that
# triggered a recovery cannot keep re-triggering recoveries on every cooldown.
LAST_RECOVERY_OFFSET_FILE="$STATE_DIR/last-recovery-log-offset"
SERVICE_LABEL="com.nanoclaw"

# Number of startup timeouts (since the last success) that means "stuck".
TIMEOUT_THRESHOLD=3
# How many recent log lines to inspect for the stuck pattern.
TAIL_LINES=250
# Minimum seconds between recoveries, so we never restart-loop.
RECOVERY_COOLDOWN=900

# Apple Container / launchctl live in these locations.
export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

mkdir -p "$STATE_DIR"

log() {
  echo "$(date '+%Y-%m-%d %H:%M:%S') [watchdog] $*" >> "$WATCHDOG_LOG"
}

# --- 1. CLEANUP ------------------------------------------------------------
# Prune stopped containers (reclaims disk, keeps the apiserver's container
# list small). `prune` only removes stopped containers — running ones,
# including the bridge sentinel, are untouched.
cleanup() {
  local reclaimed
  reclaimed=$(container prune 2>&1 | grep -i "Reclaimed" || true)
  [ -n "$reclaimed" ] && log "prune: $reclaimed"

  # Reap orphaned per-VM runtime processes: a container-runtime-linux whose
  # --uuid is a nanoclaw-* container that no longer appears in `container ls`.
  # The bridge sentinel is always preserved.
  local running_ids
  running_ids=$(container ls --format '{{.ID}}' 2>/dev/null || container ls 2>/dev/null | awk 'NR>1{print $1}')
  while read -r pid uuid; do
    [ -z "${uuid:-}" ] && continue
    case "$uuid" in
      nanoclaw-bridge-sentinel) continue ;;
      nanoclaw-*) ;;
      *) continue ;;
    esac
    if ! grep -qxF "$uuid" <<< "$running_ids"; then
      if kill -9 "$pid" 2>/dev/null; then
        log "reaped orphan runtime pid=$pid uuid=$uuid"
      fi
    fi
  done < <(ps -ax -o pid=,command= | awk '/container-runtime-linux/ && /--uuid/ {
      for (i=1;i<=NF;i++) if ($i=="--uuid") { print $1, $(i+1) }
    }')
}

# --- 2. RECOVERY -----------------------------------------------------------
# Stuck = at least TIMEOUT_THRESHOLD "No output before startup timeout" lines
# AFTER the most recent successful completion, considering ONLY log content
# written since the last recovery.
#
# The post-recovery scoping is essential: a recovery restarts the orchestrator
# but does not itself emit a success line, so the timeout lines that justified
# the recovery linger in the recent tail. Without scoping, is_stuck() would stay
# true on the next run and fire another recovery the moment the cooldown lapses
# — an infinite restart loop that re-initializes the orchestrator (and drops the
# user's in-flight chat) every cooldown interval. By ignoring everything logged
# before the last recovery we require *fresh* timeouts to accumulate before
# recovering again, so a genuine recovery that worked stays quiet.
is_stuck() {
  [ -f "$LOG" ] || return 1
  local log_size start_off slice last_success_line timeouts_after
  log_size=$(wc -c < "$LOG" 2>/dev/null | tr -dc '0-9')
  : "${log_size:=0}"
  start_off=$(tr -dc '0-9' < "$LAST_RECOVERY_OFFSET_FILE" 2>/dev/null)
  : "${start_off:=0}"
  # Guard against a rotated/truncated log (offset now past EOF).
  if ! [[ "$start_off" =~ ^[0-9]+$ ]] || [ "$start_off" -gt "$log_size" ]; then
    start_off=0
  fi

  # Inspect only the bytes written after the last recovery, then bound the work
  # to the most recent TAIL_LINES lines of that slice.
  slice=$(tail -c +"$((start_off + 1))" "$LOG" | tail -n "$TAIL_LINES")

  # Line number (within the slice) of the most recent success signal.
  last_success_line=$(grep -nE "Container completed|Container timed out after output|Agent output" <<< "$slice" | tail -1 | cut -d: -f1)
  : "${last_success_line:=0}"

  # Startup-kill messages emitted by container-runner.ts (KILL_LOG_MESSAGES) —
  # keep these patterns in sync with that map.
  timeouts_after=$(tail -n +"$((last_success_line + 1))" <<< "$slice" \
    | grep -cE "No output for startup timeout|No guest output before first-output timeout")

  [ "$timeouts_after" -ge "$TIMEOUT_THRESHOLD" ]
}

in_cooldown() {
  [ -f "$LAST_RECOVERY_FILE" ] || return 1
  local last now
  last=$(cat "$LAST_RECOVERY_FILE" 2>/dev/null || echo 0)
  now=$(date +%s)
  [ $((now - last)) -lt "$RECOVERY_COOLDOWN" ]
}

recover() {
  log "RECOVERY: stuck-spawn pattern detected — restarting apiserver + orchestrator"
  date +%s > "$LAST_RECOVERY_FILE"
  # Mark the current end of the log: only timeouts logged AFTER this point may
  # justify the next recovery, so the lines that triggered this one can't loop.
  { wc -c < "$LOG" 2>/dev/null | tr -dc '0-9' || true; } > "$LAST_RECOVERY_OFFSET_FILE"
  [ -s "$LAST_RECOVERY_OFFSET_FILE" ] || echo 0 > "$LAST_RECOVERY_OFFSET_FILE"

  container system stop  >> "$WATCHDOG_LOG" 2>&1
  sleep 3
  container system start >> "$WATCHDOG_LOG" 2>&1
  sleep 3
  launchctl kickstart -k "gui/$(id -u)/$SERVICE_LABEL" >> "$WATCHDOG_LOG" 2>&1
  log "RECOVERY: restart sequence issued"
}

# --- Main ------------------------------------------------------------------
cleanup

if is_stuck; then
  if in_cooldown; then
    log "stuck pattern seen but within recovery cooldown — skipping"
  else
    recover
  fi
fi
