#!/bin/bash
# Claude Code Notification hook.
#
# Fires when Claude Code wants your attention — e.g. it needs permission to run a
# tool, or has been waiting on your input. We forward the notification text to the
# cash-register app, which flashes a red cop-light siren and sounds a buzzer.
#
# Hooks must stay out of the way: short curl timeout, backgrounded, always exit 0.

input=$(cat)
PORT="${CASH_REGISTER_PORT:-4337}"

_cfg="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
_base="$(basename "$_cfg")"
case "$_base" in
  .claude | claude) PROFILE="default" ;;
  *) PROFILE="${_base#.claude-}"; PROFILE="${PROFILE#claude-}" ;;
esac

if command -v jq >/dev/null 2>&1; then
  payload=$(printf '%s' "$input" | jq -c '{message: (.message // ""), title: (.title // "")}' 2>/dev/null)
fi
[ -z "$payload" ] && payload='{"message":"Claude Code needs your input"}'

if command -v curl >/dev/null 2>&1; then
  printf '%s' "$payload" | curl -s -m 1 -X POST --data-binary @- \
    -H 'Content-Type: application/json' \
    "http://127.0.0.1:${PORT}/alert?profile=${PROFILE}" >/dev/null 2>&1 &
fi

exit 0
