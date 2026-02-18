#!/usr/bin/env bash
set -euo pipefail

# Cursor Queue CLI - Synchronous interface to Cursor Agent via file queue
# Usage: cursor_queue_cli.sh "<prompt>" [--id <job_id>] [--timeout <sec>]
#    or: cursor_queue_cli.sh --prompt-file <path> [--id <job_id>] [--timeout <sec>]

# Parse arguments
PROMPT=""
PROMPT_FILE=""
JOB_ID=""
TIMEOUT_S="${CURSOR_QUEUE_TIMEOUT_S:-600}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --id)
      JOB_ID="$2"
      shift 2
      ;;
    --timeout)
      TIMEOUT_S="$2"
      shift 2
      ;;
    --prompt-file)
      PROMPT_FILE="$2"
      shift 2
      ;;
    *)
      if [[ -z "$PROMPT" ]] && [[ -z "$PROMPT_FILE" ]]; then
        PROMPT="$1"
      else
        echo "Error: Multiple prompts provided or unknown option: $1" >&2
        exit 1
      fi
      shift
      ;;
  esac
done

if [[ -n "$PROMPT_FILE" ]]; then
  if [[ ! -f "$PROMPT_FILE" ]]; then
    echo "Error: Prompt file not found: $PROMPT_FILE" >&2
    exit 1
  fi
  PROMPT=$(cat "$PROMPT_FILE")
fi

# Validate prompt is provided
if [[ -z "$PROMPT" ]]; then
  echo "Error: Prompt is required (positional or --prompt-file)" >&2
  echo "Usage: cursor_queue_cli.sh \"<prompt>\" [--id <job_id>] [--timeout <sec>]" >&2
  echo "   or: cursor_queue_cli.sh --prompt-file <path> [--id <job_id>] [--timeout <sec>]" >&2
  exit 1
fi

# Determine project root (assume script is in coordinator/adapters/)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RDLOOP_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
QUEUE_DIR="$RDLOOP_ROOT/out/cursor_queue"
OUT_DIR="$RDLOOP_ROOT/out/cursor_out"

# Ensure directories exist
mkdir -p "$QUEUE_DIR" "$OUT_DIR"

# Generate job_id if not provided
if [[ -z "$JOB_ID" ]]; then
  JOB_ID="$(date +%s)-$RANDOM"
fi

# Write job file
JOB_FILE="$QUEUE_DIR/$JOB_ID.job"
printf "%s" "$PROMPT" > "$JOB_FILE"

# Poll for rc file
RC_FILE="$OUT_DIR/$JOB_ID.rc"
RESPONSE_FILE="$OUT_DIR/$JOB_ID.response.txt"
POLL_INTERVAL=0.2
START_TIME=$(date +%s)

while true; do
  if [[ -f "$RC_FILE" ]]; then
    # Read rc (remove CRLF)
    RC=$(tr -d '\r' < "$RC_FILE")
    
    # Output response if exists (remove CRLF)
    if [[ -f "$RESPONSE_FILE" ]]; then
      tr -d '\r' < "$RESPONSE_FILE"
    fi
    
    # Exit with rc value
    exit "$RC"
  fi
  
  # Check timeout
  CURRENT_TIME=$(date +%s)
  ELAPSED=$((CURRENT_TIME - START_TIME))
  if [[ $ELAPSED -ge $TIMEOUT_S ]]; then
    echo "timeout job_id=$JOB_ID" >&2
    exit 124
  fi
  
  sleep "$POLL_INTERVAL"
done
