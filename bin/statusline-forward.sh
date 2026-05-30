#!/bin/bash
# Claude Code statusLine wrapper.
#
# Claude Code pipes a JSON blob (model, token usage, rate limits…) to this script
# on stdin and renders whatever we print to stdout as the status line. We:
#   1. copy that JSON to the local cash-register app (fire-and-forget), and
#   2. hand the JSON to your real statusline.sh so your status line is unchanged.
#
# It must never hang or fail the status line, hence the short curl timeout, the
# background "&", and the silenced errors.

input=$(cat)

PORT="${CASH_REGISTER_PORT:-4321}"
REAL_STATUSLINE="${REAL_STATUSLINE:-$HOME/.claude/statusline.sh}"

# Which Claude profile is this? Derived from the active config dir name
# (.claude → "default", .claude-work → "work", .claude-personal → "personal").
_cfg="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
_base="$(basename "$_cfg")"
case "$_base" in
  .claude | claude) PROFILE="default" ;;
  *) PROFILE="${_base#.claude-}"; PROFILE="${PROFILE#claude-}" ;;
esac

# 1) Forward a copy to the cash register (non-blocking, ignore all failures).
if command -v curl >/dev/null 2>&1; then
  printf '%s' "$input" | curl -s -m 1 -X POST --data-binary @- \
    -H 'Content-Type: application/json' \
    "http://127.0.0.1:${PORT}/usage?profile=${PROFILE}" >/dev/null 2>&1 &
fi

# 2) Render the real status line (fall back to a minimal line if missing).
if [ -x "$REAL_STATUSLINE" ]; then
  printf '%s' "$input" | "$REAL_STATUSLINE"
elif [ -f "$REAL_STATUSLINE" ]; then
  printf '%s' "$input" | bash "$REAL_STATUSLINE"
else
  printf '%s' "$input" | (command -v jq >/dev/null 2>&1 \
    && jq -r '"[" + (.model.display_name // "Claude") + "] " + (.workspace.current_dir // "")' \
    || cat >/dev/null)
fi
