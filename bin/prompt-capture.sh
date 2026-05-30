#!/bin/bash
# Claude Code UserPromptSubmit hook.
#
# Fires when you submit a prompt. We forward a synopsis to the cash-register app
# so the *next* token burst (the turn this prompt triggers) can be labelled in the
# jackpot leaderboard — letting you see what the expensive requests actually were.
#
# IMPORTANT: a UserPromptSubmit hook's stdout is injected into Claude's context.
# So this script prints NOTHING to stdout — it only fires a background curl.

input=$(cat)
PORT="${CASH_REGISTER_PORT:-4321}"

if command -v jq >/dev/null 2>&1; then
  payload=$(printf '%s' "$input" | jq -c '{session: (.session_id // ""), text: (.prompt // "")}' 2>/dev/null)
fi
[ -z "$payload" ] && payload='{"text":""}'

if command -v curl >/dev/null 2>&1; then
  printf '%s' "$payload" | curl -s -m 1 -X POST --data-binary @- \
    -H 'Content-Type: application/json' \
    "http://127.0.0.1:${PORT}/prompt" >/dev/null 2>&1 &
fi

exit 0
