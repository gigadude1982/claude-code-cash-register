#!/usr/bin/env node
// Claude Code Cash Register — local server.
//
// Receives the JSON that Claude Code pipes to your statusLine command (forwarded
// by bin/statusline-forward.sh), figures out how many *new* tokens the latest
// request burned, and pushes a "burst" event to the browser over SSE. The
// browser draws an animated slot-machine cash register whose coin fountain
// scales (logarithmically) with that token count.

import http from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";
import { homedir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.CASH_REGISTER_PORT) || 4321;
const PUBLIC_DIR = join(__dirname, "public");
const DATA_FILE = join(__dirname, "data", "stats.json");

// ── per-session bookkeeping ───────────────────────────────────────────────────
// We only "cha-ching" when a genuinely new request lands. The statusLine command
// can fire several times per turn (and on idle refreshes), so we de-dupe on the
// current_usage signature per session.
const sessions = new Map(); // sessionKey -> { lastSig, lastTotals }

// ── SSE clients ───────────────────────────────────────────────────────────────
const clients = new Set();

function broadcast(event, payload) {
  const chunk = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) {
    try {
      res.write(chunk);
    } catch {
      clients.delete(res);
    }
  }
}

// ── pricing (USD per million tokens, approximate Anthropic list prices) ─────────
function priceFor(modelId) {
  const id = (modelId || "").toLowerCase();
  if (id.includes("opus")) return { in: 15, out: 75, cw: 18.75, cr: 1.5 };
  if (id.includes("haiku")) return { in: 1, out: 5, cw: 1.25, cr: 0.1 };
  return { in: 3, out: 15, cw: 3.75, cr: 0.3 }; // sonnet / default
}
function costOf(u, modelId) {
  const p = priceFor(modelId);
  return (u.input * p.in + u.output * p.out + u.cacheCreate * p.cw + u.cacheRead * p.cr) / 1e6;
}

// ── persistent stats (survive restarts) ─────────────────────────────────────────
const LEADERBOARD_MAX = 10;
// leaderboard = biggest by tokens; leaderboardCost = most expensive by $.
let stats = { allTime: { tokens: 0, cost: 0 }, daily: {}, leaderboard: [], leaderboardCost: [] };
let sessionTokens = 0; // this server run only
let sessionCost = 0;

function loadStats() {
  try {
    const j = JSON.parse(readFileSync(DATA_FILE, "utf8"));
    stats.allTime = j.allTime || stats.allTime;
    stats.daily = j.daily || {};
    stats.leaderboard = Array.isArray(j.leaderboard) ? j.leaderboard : [];
    stats.leaderboardCost = Array.isArray(j.leaderboardCost) ? j.leaderboardCost : [];
  } catch {
    /* first run */
  }
}
let saveTimer = null;
function saveStats() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      await mkdir(dirname(DATA_FILE), { recursive: true });
      await writeFile(DATA_FILE, JSON.stringify(stats, null, 2));
    } catch {
      /* non-fatal */
    }
  }, 500);
}
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const boards = () => ({
  leaderboard: stats.leaderboard.slice(0, 5),
  leaderboardCost: stats.leaderboardCost.slice(0, 5),
});
function totalsSnapshot() {
  const d = stats.daily[today()] || { tokens: 0, cost: 0 };
  return {
    session: { tokens: sessionTokens, cost: sessionCost },
    today: { tokens: d.tokens, cost: d.cost },
    allTime: { tokens: stats.allTime.tokens, cost: stats.allTime.cost },
  };
}

// Insert into a capped leaderboard sorted by `key`. Returns 1-based rank, or 0.
function placeOn(board, entry, key) {
  const lowest = board.length < LEADERBOARD_MAX ? -1 : board[board.length - 1][key];
  if (board.length < LEADERBOARD_MAX || entry[key] > lowest) {
    board.push(entry);
    board.sort((a, b) => b[key] - a[key]);
    board.length = Math.min(LEADERBOARD_MAX, board.length);
    return board.indexOf(entry) + 1; // 0 if it fell off after the sort
  }
  return 0;
}

// Record one turn into all the running totals + both leaderboards.
// Returns { rankTokens, rankCost, ts }.
function recordTurn(tokens, cost, model, label, profile) {
  sessionTokens += tokens;
  sessionCost += cost;
  const d = stats.daily[today()] || (stats.daily[today()] = { tokens: 0, cost: 0 });
  d.tokens += tokens;
  d.cost += cost;
  stats.allTime.tokens += tokens;
  stats.allTime.cost += cost;

  const ts = Date.now();
  const entry = { tokens, cost, model, label: label || "", profile: profile || "default", ts };
  const rankTokens = placeOn(stats.leaderboard, { ...entry }, "tokens");
  const rankCost = placeOn(stats.leaderboardCost, { ...entry }, "cost");
  saveStats();
  return { rankTokens, rankCost, ts };
}

// ── recent prompt synopsis per session (labels the jackpot leaderboard) ────────
// Keyed strictly by session so a turn only ever borrows its OWN session's prompt
// — no cross-session guessing. The statusLine JSON and the UserPromptSubmit hook
// both carry session_id, which is the reliable join key.
const sessionPrompts = new Map(); // session key -> { text, ts }
function synopsis(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
}
function setPrompt(session, text) {
  const s = synopsis(text);
  if (!s || !session) return;
  sessionPrompts.set(String(session), { text: s, ts: Date.now() });
}
function promptFor(info) {
  for (const k of [info.sessionId, info.session].filter(Boolean)) {
    const e = sessionPrompts.get(String(k));
    if (e) return e.text;
  }
  return ""; // its session never submitted a prompt → leave unlabelled
}

// ── account info, resolved per Claude profile ──────────────────────────────────
// A profile maps to a config dir: "default" → ~/.claude, "work" → ~/.claude-work,
// etc. We read each profile's own .claude.json so the header shows the right
// user/org for whichever profile just spent tokens. Results are cached.
const HOME = homedir();
function configDirFor(profile) {
  if (!profile || profile === "default") return join(HOME, ".claude");
  return join(HOME, `.claude-${profile}`);
}
// The server's own profile, for events that aren't tagged with one (e.g. hello).
function profileFromDir(cfg) {
  const base = (cfg || "").split("/").pop() || "";
  if (!base || base === ".claude" || base === "claude") return "default";
  return base.replace(/^\.?claude-/, "");
}
const OWN_PROFILE = profileFromDir(process.env.CLAUDE_CONFIG_DIR || join(HOME, ".claude"));

const acctCache = new Map();
function accountFor(profile) {
  const key = profile || OWN_PROFILE;
  if (acctCache.has(key)) return acctCache.get(key);
  const cfg = configDirFor(key);
  let email = "";
  let org = "";
  let role = "";
  try {
    const o = JSON.parse(readFileSync(join(cfg, ".claude.json"), "utf8")).oauthAccount || {};
    email = o.emailAddress || o.email || "";
    org = o.organizationName || "";
    role = o.organizationRole || o.workspaceRole || "";
  } catch {
    for (const name of ["auth.json", ".credentials.json", "credentials.json", "account.json"]) {
      try {
        const j = JSON.parse(readFileSync(join(cfg, name), "utf8"));
        email = j.email || j.account_email || j.userEmail || "";
        if (email) break;
      } catch {
        /* ignore */
      }
    }
  }
  const out = { account: key === "default" ? "Claude Code" : key, profile: key, email, org, role };
  acctCache.set(key, out);
  return out;
}
const ACCOUNT = accountFor(OWN_PROFILE).account; // back-compat string label
function accountPayload(profile) {
  return accountFor(profile);
}

// ── usage parsing ──────────────────────────────────────────────────────────────
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function parseUsage(data, profile) {
  const ctx = data.context_window || {};
  const cu = ctx.current_usage || {};
  const usage = {
    input: num(cu.input_tokens),
    output: num(cu.output_tokens),
    cacheCreate: num(cu.cache_creation_input_tokens),
    cacheRead: num(cu.cache_read_input_tokens),
  };
  // "felt cost" of this turn = the genuinely new tokens (exclude the big,
  // roughly-constant cache reads so the number actually varies per request).
  const turnTokens = usage.input + usage.output + usage.cacheCreate;
  const modelId = data.model?.id || "";
  // Dollar cost DOES include cache reads — they're cheap but real.
  const cost = costOf(usage, modelId);

  return {
    usage,
    turnTokens,
    cost,
    model: data.model?.display_name || data.model?.id || "Claude",
    modelId,
    contextSize: num(ctx.context_window_size),
    usedPct: ctx.used_percentage != null ? num(ctx.used_percentage) : null,
    totalIn: ctx.total_input_tokens != null ? num(ctx.total_input_tokens) : null,
    totalOut: ctx.total_output_tokens != null ? num(ctx.total_output_tokens) : null,
    rate5h: data.rate_limits?.five_hour?.used_percentage ?? null,
    rate7d: data.rate_limits?.seven_day?.used_percentage ?? null,
    session: data.session_name || data.session_id || "default",
    sessionId: data.session_id || "",
    ...accountPayload(profile),
  };
}

function handleUsage(raw, profile) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return;
  }
  const info = parseUsage(data, profile);
  if (!data.context_window || !data.context_window.current_usage) {
    // Before the first API call there's nothing to celebrate.
    Object.assign(info, { totals: totalsSnapshot() }, boards());
    broadcast("state", info);
    return;
  }

  const sig = JSON.stringify(info.usage);
  const prev = sessions.get(info.session);
  const isNewTurn = !prev || prev.lastSig !== sig;

  // A new turn = the per-message usage signature changed for this session.
  if (isNewTurn && info.turnTokens > 0) {
    sessions.set(info.session, { lastSig: sig, lastTotals: info });
    info.promptLabel = promptFor(info);
    const r = recordTurn(info.turnTokens, info.cost, info.model, info.promptLabel, info.profile);
    info.rank = r.rankTokens; // jackpot celebration is token-based
    info.rankCost = r.rankCost;
    info.entryTs = r.ts;
    Object.assign(info, { totals: totalsSnapshot() }, boards());
    broadcast("state", info); // refresh header first
    broadcast("burst", info);
  } else {
    if (!prev) sessions.set(info.session, { lastSig: sig, lastTotals: info });
    Object.assign(info, { totals: totalsSnapshot() }, boards());
    broadcast("state", info);
  }
}

// ── static file serving ─────────────────────────────────────────────────────────
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

async function serveStatic(req, res) {
  let path = req.url.split("?")[0];
  if (path === "/") path = "/index.html";
  const file = join(PUBLIC_DIR, path);
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end("forbidden");
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { "Content-Type": MIME[extname(file)] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
}

// ── server ──────────────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // Live event stream to the browser.
  if (url.pathname === "/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    const hello = { ...accountPayload(), totals: totalsSnapshot(), ...boards(), day: today() };
    res.write(`event: hello\ndata: ${JSON.stringify(hello)}\n\n`);
    clients.add(res);
    const keepAlive = setInterval(() => res.write(": ping\n\n"), 25000);
    req.on("close", () => {
      clearInterval(keepAlive);
      clients.delete(res);
    });
    return;
  }

  // Forwarded statusLine JSON.
  if (url.pathname === "/usage" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > 1_000_000) req.destroy(); // sanity cap
    });
    const profile = url.searchParams.get("profile") || "";
    req.on("end", () => {
      handleUsage(body, profile);
      res.writeHead(204).end();
    });
    return;
  }

  // UserPromptSubmit hook → remember the prompt to label the next jackpot.
  if (url.pathname === "/prompt" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > 200_000) req.destroy();
    });
    const profile = url.searchParams.get("profile") || "";
    req.on("end", () => {
      let prof = profile;
      try {
        const j = JSON.parse(body);
        setPrompt(j.session || j.session_id, j.text || j.prompt);
        prof = prof || j.profile || "";
      } catch {}
      // You just answered → silence the escalating "needs input" alarm.
      broadcast("alertstop", { profile: prof });
      res.writeHead(204).end();
    });
    return;
  }

  // Manual test: GET /burst?tokens=12345[&model=opus]
  if (url.pathname === "/burst") {
    const tokens = Number(url.searchParams.get("tokens")) || 5000;
    const modelId = url.searchParams.get("model") || "claude-sonnet-4-6";
    const usage = {
      input: Math.round(tokens * 0.05),
      output: Math.round(tokens * 0.55),
      cacheCreate: Math.round(tokens * 0.4),
      cacheRead: Math.round(tokens * 4),
    };
    const cost = costOf(usage, modelId);
    const label = url.searchParams.get("label") || "🎰 manual test spin";
    const profile = url.searchParams.get("profile") || OWN_PROFILE;
    const r = recordTurn(tokens, cost, "Test Reel", label, profile);
    const payload = {
      model: "Test Reel",
      modelId,
      ...accountPayload(profile),
      turnTokens: tokens,
      cost,
      usage,
      usedPct: null,
      session: "test",
      rank: r.rankTokens,
      rankCost: r.rankCost,
      entryTs: r.ts,
      promptLabel: label,
      totals: totalsSnapshot(),
      ...boards(),
    };
    broadcast("state", payload);
    broadcast("burst", payload);
    res.writeHead(200, { "Content-Type": "text/plain" }).end(`cha-ching: ${tokens} tokens · $${cost.toFixed(4)}${r.rankTokens ? ` · #${r.rankTokens} tokens` : ""}${r.rankCost ? ` · #${r.rankCost} cost` : ""}\n`);
    return;
  }

  // Notification hook → red siren + buzzer in the browser.
  if (url.pathname === "/alert") {
    const profile = url.searchParams.get("profile") || OWN_PROFILE;
    const fire = (msg) => {
      broadcast("alert", { message: (msg && msg.message) || "Claude Code needs your input", title: (msg && msg.title) || "", profile });
      res.writeHead(204).end();
    };
    if (req.method === "POST") {
      let body = "";
      req.on("data", (c) => {
        body += c;
        if (body.length > 100_000) req.destroy();
      });
      req.on("end", () => {
        let msg = {};
        try {
          msg = JSON.parse(body);
        } catch {}
        fire(msg);
      });
    } else {
      fire({ message: url.searchParams.get("message") || "Test siren" });
    }
    return;
  }

  // Manually silence the alarm (same as answering a prompt). ?profile= scopes it.
  if (url.pathname === "/alertstop") {
    broadcast("alertstop", { profile: url.searchParams.get("profile") || "" });
    res.writeHead(200, { "Content-Type": "text/plain" }).end("alarm silenced\n");
    return;
  }

  // Stats JSON + reset.
  if (url.pathname === "/stats") {
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ totals: totalsSnapshot(), leaderboard: stats.leaderboard, leaderboardCost: stats.leaderboardCost }, null, 2));
    return;
  }
  if (url.pathname === "/reset") {
    stats = { allTime: { tokens: 0, cost: 0 }, daily: {}, leaderboard: [], leaderboardCost: [] };
    sessionTokens = 0;
    sessionCost = 0;
    saveStats();
    const snap = { ...accountPayload(), totals: totalsSnapshot(), ...boards(), day: today() };
    broadcast("hello", snap);
    res.writeHead(200, { "Content-Type": "text/plain" }).end("stats reset\n");
    return;
  }
  // Manual test: GET /newday  (simulate a midnight rollover)
  if (url.pathname === "/newday") {
    const prev = stats.daily[currentDay] || { tokens: 0, cost: 0 };
    currentDay = today();
    broadcast("newday", { date: currentDay, previous: { tokens: prev.tokens, cost: prev.cost } });
    res.writeHead(200, { "Content-Type": "text/plain" }).end("new day broadcast\n");
    return;
  }

  serveStatic(req, res);
});

loadStats();

// ── daily rollover watcher (fires the new-day chime at local midnight) ──────────
let currentDay = today();
setInterval(() => {
  const d = today();
  if (d !== currentDay) {
    const prev = stats.daily[currentDay] || { tokens: 0, cost: 0 };
    currentDay = d;
    broadcast("newday", { date: d, previous: { tokens: prev.tokens, cost: prev.cost } });
  }
}, 30_000).unref();

server.listen(PORT, () => {
  const url = `http://127.0.0.1:${PORT}`;
  console.log(`\n  💰  Claude Code Cash Register is open for business`);
  console.log(`      account: ${ACCOUNT}`);
  console.log(`      open:    ${url}`);
  console.log(`      test:    curl "${url}/burst?tokens=42000"\n`);

  if (process.platform === "darwin" && !process.env.NO_OPEN) {
    import("node:child_process").then(({ exec }) => exec(`open "${url}"`));
  }
});
