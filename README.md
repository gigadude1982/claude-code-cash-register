# Claude Code Cash Register 💰

An animated slot-machine cash register that **cha-chings every time Claude Code
spends tokens**. The coin fountain, reel spin, screen shake, and bell flash all
scale **logarithmically** with the number of new tokens the latest request
burned.

![concept](https://img.shields.io/badge/coins-flowing-ffcf3f)

## How it works

Claude Code pipes a JSON blob to your `statusLine` command on every update —
model, live token usage, context %, rate limits. We splice a tiny forwarder into
that command:

```
Claude Code ──stdin JSON──▶ bin/statusline-forward.sh ──┬──▶ your real statusline.sh (unchanged)
                                                        └──▶ POST /usage ──▶ server.js
                                                                                  │ SSE
                                                                                  ▼
                                                                         browser canvas 🎰
```

`server.js` figures out the **new** tokens for the latest turn
(`input + output + cache_creation`, deliberately excluding the big, roughly
constant cache-reads so the number actually varies), de-dupes repeat statusLine
calls within a turn, and pushes a `burst` event. The browser draws the register
and plays a synthesized "cha-ching" (Web Audio — no asset files).

No external dependencies — pure Node built-ins.

## Features

- **Animated brass-and-green cash register** with spinning slot reels, a coin
  fountain, ambient gold dust, and a glowing "TOTAL" sign — all scaled
  logarithmically to the per-request token count.
- **Dollar cost** per turn and cumulative, using approximate Anthropic per-model
  list prices (Opus / Sonnet / Haiku), shown on the register and in the HUD.
- **Persistent totals** — session / today / all-time tokens + cost survive
  restarts (`data/stats.json`).
- **Jackpot leaderboard** with a **Tokens / Cost toggle** — two boards, the
  biggest single-turn token burns and the most expensive turns by `$` (they can
  rank differently). Each entry is labelled with a **synopsis of the prompt**
  that triggered it (captured via a `UserPromptSubmit` hook, matched strictly by
  session so a turn only ever shows its own prompt). New #1s trigger a fanfare.
- **Daily-reset chime** — a gentle chime + banner at local midnight when the
  "today" total rolls over.
- **Logged-in user + organization** shown in the header (read from
  `oauthAccount` in `~/.claude-personal/.claude.json`).
- **Red cop-light siren + buzzer** when Claude Code needs your input/permission
  (driven by a `Notification` hook), auto-clearing after 8s or on any click/key.

## Hooks installed (in `~/.claude-personal/settings.json`)

| Hook               | Script                      | Purpose                                  |
| ------------------ | --------------------------- | ---------------------------------------- |
| `statusLine`       | `bin/statusline-forward.sh` | forward token usage (and run your real status line) |
| `Notification`     | `bin/notify-alert.sh`       | trigger the siren + buzzer               |
| `UserPromptSubmit` | `bin/prompt-capture.sh`     | label jackpots with the prompt synopsis  |

The `UserPromptSubmit` hook prints nothing to stdout (that stream is injected
into Claude's context); it only fires a background `curl`.

## Run it

```bash
npm start          # starts the server on http://127.0.0.1:4321 and opens your browser
```

Then just use Claude Code as normal. Every request that spends tokens triggers a
burst. Click **🔊 enable cha-ching** once (browsers block autoplay audio).

### Launch from anywhere

There's a self-contained launcher at the repo root. Symlink it onto your `PATH`
once and you can start the register from any directory (it's idempotent — if a
server is already running it just opens the browser):

```bash
ln -sf "$PWD/claude-code-cash-register" ~/.local/bin/claude-code-cash-register
claude-code-cash-register        # from anywhere
```

(Use any dir on your `PATH`; `~/.local/bin` is a common one. Or just run
`./claude-code-cash-register` from the repo.)

### Test without spending tokens

```bash
curl "http://127.0.0.1:4321/burst?tokens=42000"                 # small/medium/big/JACKPOT by amount
curl "http://127.0.0.1:4321/burst?tokens=90000&model=opus&label=huge+refactor"  # labelled jackpot
curl "http://127.0.0.1:4321/alert?message=Permission+needed"    # red siren + buzzer
curl "http://127.0.0.1:4321/newday"                             # simulate midnight rollover (chime)
curl "http://127.0.0.1:4321/stats"                              # JSON of totals + both leaderboards
curl "http://127.0.0.1:4321/reset"                              # wipe totals + leaderboards
npm run test:burst 1500
```

### Browser URL options

- `http://127.0.0.1:4321/?board=cost` — open straight to the cost leaderboard
- `http://127.0.0.1:4321/?nogate` — skip the click-to-enable-sound overlay (for
  an always-on, muted dashboard on a second monitor)

## Configuration

| Env var               | Default                     | Meaning                                  |
| --------------------- | --------------------------- | ---------------------------------------- |
| `CASH_REGISTER_PORT`  | `4321`                      | Port for server + forwarder              |
| `REAL_STATUSLINE`     | `~/.claude/statusline.sh`   | Your original statusLine script to chain |
| `NO_OPEN`             | _(unset)_                   | Set to skip auto-opening the browser     |

## Wiring (already done)

Your active config (`~/.claude-personal/settings.json`) `statusLine.command` now
points at `bin/statusline-forward.sh`, which forwards a copy of the token JSON to
this app and then runs your original `~/.claude/statusline.sh` unchanged. The
forwarder uses a 1-second curl timeout and a background job, so it can never hang
or break your status line — if the app isn't running, the forward silently
no-ops.

### To uninstall

In `~/.claude-personal/settings.json`: set `statusLine.command` back to
`"~/.claude/statusline.sh"`, and remove the `Notification` + `UserPromptSubmit`
entries from `hooks` (or the whole `hooks` block if you added nothing else).

## Tuning the animation

All the knobs live near the top of `public/app.js`:

- `coinCount(tokens)` — how many coins fly out
- `intensity(tokens)` / `tierOf(t)` — shake, glow, reel-spin time, and the
  small/big/**JACKPOT** tiers
- `REEL_SYMBOLS` — the slot reel faces
