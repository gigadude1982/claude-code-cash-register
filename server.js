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
let stats = { allTime: { tokens: 0, cost: 0 }, daily: {}, leaderboard: [] };
let sessionTokens = 0; // this server run only
let sessionCost = 0;

function loadStats() {
  try {
    const j = JSON.parse(readFileSync(DATA_FILE, "utf8"));
    stats.allTime = j.allTime || stats.allTime;
    stats.daily = j.daily || {};
    stats.leaderboard = Array.isArray(j.leaderboard) ? j.leaderboard : [];
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
function totalsSnapshot() {
  const d = stats.daily[today()] || { tokens: 0, cost: 0 };
  return {
    session: { tokens: sessionTokens, cost: sessionCost },
    today: { tokens: d.tokens, cost: d.cost },
    allTime: { tokens: stats.allTime.tokens, cost: stats.allTime.cost },
  };
}

// Record one turn into all the running totals + leaderboard.
// Returns the leaderboard rank (1-based) if it cracked the top, else 0.
function recordTurn(tokens, cost, model, label) {
  sessionTokens += tokens;
  sessionCost += cost;
  const d = stats.daily[today()] || (stats.daily[today()] = { tokens: 0, cost: 0 });
  d.tokens += tokens;
  d.cost += cost;
  stats.allTime.tokens += tokens;
  stats.allTime.cost += cost;

  let rank = 0;
  const board = stats.leaderboard;
  const lowest = board.length < LEADERBOARD_MAX ? -1 : board[board.length - 1].tokens;
  if (board.length < LEADERBOARD_MAX || tokens > lowest) {
    const entry = { tokens, cost, model, label: label || "", ts: Date.now() };
    board.push(entry);
    board.sort((a, b) => b.tokens - a.tokens);
    board.length = Math.min(LEADERBOARD_MAX, board.length);
    rank = board.indexOf(entry) + 1; // 0 if it fell off after the sort
  }
  saveStats();
  return rank;
}

// ── recent prompt synopsis per session (labels the jackpot leaderboard) ────────
const sessionPrompts = new Map(); // session key -> { text, ts }
let lastPromptAny = null;
function synopsis(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
}
function setPrompt(session, text) {
  const s = synopsis(text);
  if (!s) return;
  const entry = { text: s, ts: Date.now() };
  if (session) sessionPrompts.set(String(session), entry);
  lastPromptAny = entry;
}
function promptFor(info) {
  for (const k of [info.sessionId, info.session].filter(Boolean)) {
    const e = sessionPrompts.get(String(k));
    if (e) return e.text;
  }
  // fall back to the most recent prompt if it's fresh (within 10 min)
  if (lastPromptAny && Date.now() - lastPromptAny.ts < 600000) return lastPromptAny.text;
  return "";
}

// ── account info (profile label + logged-in user + organization) ───────────────
function readAccount() {
  const cfg = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");

  // profile label from the config dir name (e.g. ".claude-personal" → "personal")
  const base = cfg.split("/").pop() || "";
  let label = "Claude Code";
  if (base && base !== ".claude" && base !== "claude") label = base.replace(/^\.?claude-/, "");

  // logged-in user + org from .claude.json's oauthAccount block
  let email = "";
  let org = "";
  let role = "";
  try {
    const j = JSON.parse(readFileSync(join(cfg, ".claude.json"), "utf8"));
    const o = j.oauthAccount || {};
    email = o.emailAddress || o.email || "";
    org = o.organizationName || "";
    role = o.organizationRole || o.workspaceRole || "";
  } catch {
    /* not logged in / no config */
  }
  // fall back to other known auth files for the email
  if (!email) {
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
  return { label, email, org, role };
}
const ACCT = readAccount();
const ACCOUNT = ACCT.label; // back-compat: existing payloads use a string label
function accountPayload() {
  return { account: ACCT.label, email: ACCT.email, org: ACCT.org, role: ACCT.role };
}

// ── usage parsing ──────────────────────────────────────────────────────────────
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function parseUsage(data) {
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
    ...accountPayload(),
  };
}

function handleUsage(raw) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return;
  }
  const info = parseUsage(data);
  if (!data.context_window || !data.context_window.current_usage) {
    // Before the first API call there's nothing to celebrate.
    info.totals = totalsSnapshot();
    info.leaderboard = stats.leaderboard.slice(0, 5);
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
    info.rank = recordTurn(info.turnTokens, info.cost, info.model, info.promptLabel);
    info.totals = totalsSnapshot();
    info.leaderboard = stats.leaderboard.slice(0, 5);
    broadcast("state", info); // refresh header first
    broadcast("burst", info);
  } else {
    if (!prev) sessions.set(info.session, { lastSig: sig, lastTotals: info });
    info.totals = totalsSnapshot();
    info.leaderboard = stats.leaderboard.slice(0, 5);
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
    const hello = { ...accountPayload(), totals: totalsSnapshot(), leaderboard: stats.leaderboard.slice(0, 5) };
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
    req.on("end", () => {
      handleUsage(body);
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
    req.on("end", () => {
      try {
        const j = JSON.parse(body);
        setPrompt(j.session || j.session_id, j.text || j.prompt);
      } catch {}
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
    const rank = recordTurn(tokens, cost, "Test Reel", label);
    const payload = {
      model: "Test Reel",
      modelId,
      ...accountPayload(),
      turnTokens: tokens,
      cost,
      usage,
      usedPct: null,
      session: "test",
      rank,
      promptLabel: label,
      totals: totalsSnapshot(),
      leaderboard: stats.leaderboard.slice(0, 5),
    };
    broadcast("state", payload);
    broadcast("burst", payload);
    res.writeHead(200, { "Content-Type": "text/plain" }).end(`cha-ching: ${tokens} tokens · $${cost.toFixed(4)}${rank ? ` · #${rank}!` : ""}\n`);
    return;
  }

  // Notification hook → red siren + buzzer in the browser.
  if (url.pathname === "/alert") {
    const fire = (msg) => {
      broadcast("alert", { message: (msg && msg.message) || "Claude Code needs your input", title: (msg && msg.title) || "" });
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

  // Stats JSON + reset.
  if (url.pathname === "/stats") {
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ totals: totalsSnapshot(), leaderboard: stats.leaderboard }, null, 2));
    return;
  }
  if (url.pathname === "/reset") {
    stats = { allTime: { tokens: 0, cost: 0 }, daily: {}, leaderboard: [] };
    sessionTokens = 0;
    sessionCost = 0;
    saveStats();
    const snap = { ...accountPayload(), totals: totalsSnapshot(), leaderboard: [] };
    broadcast("hello", snap);
    res.writeHead(200, { "Content-Type": "text/plain" }).end("stats reset\n");
    return;
  }

  serveStatic(req, res);
});

loadStats();

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
