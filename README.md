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
- **Golden-brick-road backdrop** — a gold brick road receding to a glowing
  horizon, gold-bar stacks on the verge, and coins endlessly raining from the sky.
- **Dollar cost** per turn and cumulative, using approximate Anthropic per-model
  list prices (Opus / Sonnet / Haiku), shown on the register and in the HUD.
- **Persistent totals** — session / today / all-time tokens + cost survive
  restarts (`data/stats.json`), tracked **combined and per-profile** (a left-hand
  scoreboard breaks down each profile's session/today/all-time).
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

Install the launcher globally with `npm link` (uses the package's `bin`):

```bash
npm link                         # one time, from the repo
claude-code-cash-register        # …then run from any directory
cash-register                    # short alias
```

It's idempotent — if a server is already running it just opens the browser
instead of failing on a port clash. (`npm unlink -g claude-code-cash-register`
removes it. You can also just run `./claude-code-cash-register` from the repo
without linking.)

### Multiple Claude profiles (work / personal / …)

Run **one** cash register — every profile reports into it. Each hook tags its
events with the profile (derived from `CLAUDE_CONFIG_DIR`: `~/.claude-work` →
`work`), and the browser gives each profile its **own colour and sound** (a
distinct cha-ching pitch + buzzer tone) so you can tell work from personal by ear
and eye. Bursts, the leaderboard, the header, and the "needs input" alarm are all
profile-aware — two profiles can even be alarming at once with different pitches.

Wire up each profile once with the installer:

```bash
node bin/install-hooks.mjs ~/.claude-work       # add hooks to the work profile
node bin/install-hooks.mjs ~/.claude-personal   # (idempotent)
```

It's non-destructive (backs up `settings.json`, preserves any existing status
line via `REAL_STATUSLINE`). Then just `claude-code-cash-register` once and use
Claude under any profile as normal. Tune the per-profile colours/sounds in
`PROFILE_VOICES` near the top of `public/app.js`.

### Test without spending tokens

```bash
curl "http://127.0.0.1:4321/burst?tokens=42000"                 # small/medium/big/JACKPOT by amount
curl "http://127.0.0.1:4321/burst?tokens=90000&model=opus&label=huge+refactor"  # labelled jackpot
curl "http://127.0.0.1:4321/burst?tokens=12000&profile=work"    # test the work profile's sound/colour
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
