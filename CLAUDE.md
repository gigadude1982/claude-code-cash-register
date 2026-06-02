# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A local Node server + browser canvas that animates a slot-machine cash register
which "cha-chings" every time Claude Code spends tokens. It is fed entirely by
**Claude Code hooks** — it has no knowledge of Claude except the JSON those hooks
forward to it.

## Commands

```bash
npm start                                   # run server on http://127.0.0.1:4337, open browser
node server.js                              # same, without the npm wrapper
npm run test:burst 1500                     # fire a synthetic burst via the running server
node bin/install-hooks.mjs ~/.claude-work   # wire the hooks into a Claude profile (idempotent, backs up settings.json)
npm link                                    # install `claude-code-cash-register` / `cash-register` on PATH
```

There is **no build step, no test suite, no linter, and no dependencies** — pure
Node built-ins on the server and vanilla browser JS on the front end. "Running
the app" is how you verify a change.

Drive the running server without spending tokens (see README for the full list):

```bash
curl "http://127.0.0.1:4337/burst?tokens=42000"              # small→JACKPOT scales by amount (≳25k = jackpot tier)
curl "http://127.0.0.1:4337/burst?tokens=12000&profile=work" # exercise a profile's colour/sound
curl "http://127.0.0.1:4337/alert?message=Permission+needed" # red siren + buzzer
curl "http://127.0.0.1:4337/newday"                          # simulate the midnight rollover chime
curl "http://127.0.0.1:4337/reset"                           # wipe persisted totals + leaderboards
```

`?nogate` on the URL arms the scene without the click-to-enable-sound overlay
(handy for headless screenshots); `?board=cost` opens straight to the cost board.

## Architecture

**Data flow (one direction, hook-driven):**

```
Claude Code ─stdin JSON→ bin/statusline-forward.sh ─┬→ your real statusline.sh (unchanged)
                                                    └→ POST /usage → server.js ─SSE→ public/app.js (canvas)
bin/notify-alert.sh   ─→ POST /alert   → server.js ─SSE→ siren
bin/prompt-capture.sh ─→ POST /prompt  → server.js (labels the next jackpot)
```

The forwarder must never hang or break the status line, so every hook fires a
backgrounded `curl` with a 1s timeout and silenced errors — if the app is down,
the forward silently no-ops.

**`server.js`** — the entire backend in one file. An `http` server that:
- de-dupes repeat statusLine calls within a turn (the command fires several times
  per turn) by hashing `current_usage` per session, so a "burst" only fires on a
  genuinely new turn;
- computes **turn tokens = `input + output + cache_creation`** (cache *reads* are
  deliberately excluded so the number visibly varies per request), while the
  **dollar cost does include cache reads** at approximate per-model list prices
  (`priceFor`);
- broadcasts SSE events to all browser clients: `hello` (on connect), `state`
  (header/board refresh), `burst` (the cha-ching), `alert`/`alertstop`, `newday`;
- persists running totals + both leaderboards to `data/stats.json` (gitignored,
  debounced writes), tracked combined **and per-profile**.

**`public/app.js`** — the entire frontend in one file: a `requestAnimationFrame`
canvas scene (register, slot reels, coin fountain, the gold-brick-road/green
backdrop) plus **Web Audio**-synthesized sounds (no audio asset files). It opens
one `EventSource("/events")` and maps each SSE event to a render. The scene stays
dormant (`armed = false`) until the user clicks enable or loads `?nogate`; spend
that lands while dormant is banked in `pending` and replayed as one catch-up
burst. **Loaded as `<script type="module">`, so its top-level state (`armed`,
`coins`, `state`, …) is NOT on `window`** — when verifying in a browser, assert
against DOM signals (`#last-event`, `#today`, `#version`) instead.

**Profiles** — a Claude config dir maps to a profile name: `~/.claude` →
`default`, `~/.claude-work` → `work`. Both the hook scripts (from
`CLAUDE_CONFIG_DIR`) and the server (`profileFromDir`) derive it the same way.
One cash register serves every profile at once; each gets its own colour and
cha-ching/buzzer pitch, tuned in `PROFILE_VOICES` near the top of `public/app.js`.
Account/org for the header is read from `oauthAccount` in each profile's
`<configdir>/.claude.json`.

**Animation knobs** live near the top of `public/app.js`: `coinCount`,
`intensity`/`tierOf` (shake, glow, spin time, and the small/big/JACKPOT tiers),
`REEL_SYMBOLS`. The app version shown in the footer is read from `package.json`
by the server and delivered in the `hello` payload — bump `package.json` to
change it.

## Working in this repo

- **Front-end edits (`public/*`) need only a browser refresh** — `server.js`
  serves them from disk with `Cache-Control: no-cache` on every request. Only
  restart the server when **`server.js` itself** changes.
- `CASH_REGISTER_PORT` overrides the port (server + all hook forwarders must
  agree); `REAL_STATUSLINE` points the forwarder at your original status line;
  `NO_OPEN` skips the browser auto-open.
- The hooks are configured in the user's Claude `settings.json` (e.g.
  `~/.claude-personal/settings.json`), outside this repo — use
  `bin/install-hooks.mjs` rather than editing it by hand.
