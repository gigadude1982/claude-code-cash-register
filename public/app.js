// Claude Code Cash Register — frontend animation.
// Listens to /events (SSE) and plays a slot-machine cash-register burst whose
// coin volume + intensity scale logarithmically with the token count.

const canvas = document.getElementById("stage");
const ctx = canvas.getContext("2d");

const el = {
  account: document.getElementById("account"),
  user: document.getElementById("user"),
  org: document.getElementById("org"),
  model: document.getElementById("model"),
  ctx: document.getElementById("ctx"),
  today: document.getElementById("today"),
  alltime: document.getElementById("alltime"),
  board: document.getElementById("board-list"),
  tabTokens: document.getElementById("tab-tokens"),
  tabCost: document.getElementById("tab-cost"),
  lastEvent: document.getElementById("last-event"),
  connDot: document.getElementById("conn-dot"),
  soundGate: document.getElementById("sound-gate"),
  enableSound: document.getElementById("enable-sound"),
  siren: document.getElementById("siren"),
  sirenText: document.getElementById("siren-text"),
};

// ── responsive canvas ───────────────────────────────────────────────────────
let W = 0,
  H = 0,
  DPR = 1;
function resize() {
  DPR = Math.min(window.devicePixelRatio || 1, 2);
  W = canvas.clientWidth;
  H = canvas.clientHeight;
  canvas.width = Math.floor(W * DPR);
  canvas.height = Math.floor(H * DPR);
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  seedDust();
}
window.addEventListener("resize", resize);

// ── world state ─────────────────────────────────────────────────────────────
const REEL_SYMBOLS = ["🍒", "🪙", "💵", "⭐", "💎", "7️⃣"];
const coins = [];
let sparks = [];
const dust = []; // ambient floating gold motes

const state = {
  account: "Claude Code",
  model: "—",
  sessionTotal: 0,
  sessionCost: 0,
  ctxPct: null,
  boards: { tokens: [], cost: [] }, // leaderboards by view
  boardView: "tokens",
  day: null,
  // animation
  shake: 0,
  glow: 0, // 0..1 register glow
  drawer: 0, // 0..1 drawer open amount
  bell: 0, // 0..1 bell flash
  reels: [0, 0, 0].map(() => ({ symbol: 0, spinUntil: 0, offset: 0, speed: 0 })),
  lastTier: 0,
  popup: null, // { text, life, color }
};

// ── scaling math (logarithmic) ──────────────────────────────────────────────
// More gold: bumped multiplier + ceiling so big turns truly rain coins.
function coinCount(tokens) {
  return clamp(Math.round(22 * Math.log10(tokens + 1) - 8), 8, 320);
}
function intensity(tokens) {
  return clamp((Math.log10(tokens + 1) - 1) / 4, 0, 1); // ~10 tok→0, ~100k→1
}
function tierOf(t) {
  if (t >= 0.85) return 4; // JACKPOT
  if (t >= 0.6) return 3;
  if (t >= 0.35) return 2;
  if (t >= 0.15) return 1;
  return 0;
}
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const rand = (a, b) => a + Math.random() * (b - a);

// ── ambient gold dust (always drifting in the background) ────────────────────
function seedDust() {
  dust.length = 0;
  const count = Math.round((W * H) / 22000);
  for (let i = 0; i < count; i++) {
    dust.push({
      x: Math.random() * W,
      y: Math.random() * H,
      r: rand(0.6, 2.4),
      vy: rand(-0.25, -0.05),
      vx: rand(-0.12, 0.12),
      tw: rand(0, Math.PI * 2), // twinkle phase
      a: rand(0.15, 0.6),
    });
  }
}
function spawnDustBurst(g, inten) {
  const n = Math.round(30 + inten * 90);
  for (let i = 0; i < n; i++) {
    dust.push({
      x: g.cx + rand(-g.bw / 2, g.bw / 2),
      y: g.by + g.bh * 0.6,
      r: rand(1, 3.2),
      vy: rand(-1.6, -0.4),
      vx: rand(-0.8, 0.8),
      tw: rand(0, Math.PI * 2),
      a: rand(0.4, 0.9),
      decay: rand(0.004, 0.01),
    });
  }
}

// ── register geometry (recomputed each frame) ───────────────────────────────
function geom() {
  const cx = W / 2;
  const scale = clamp(Math.min(W / 760, H / 620), 0.55, 1.6);
  const bw = 460 * scale;
  const bh = 300 * scale;
  const bx = cx - bw / 2;
  const by = H / 2 - bh / 2 + 20 * scale;
  return { cx, scale, bw, bh, bx, by, s: scale };
}

// ── incoming events ──────────────────────────────────────────────────────────
function applyState(d) {
  if (d.account) {
    state.account = d.account;
    el.account.textContent = d.account;
  }
  if (d.email !== undefined) el.user.textContent = d.email || "";
  if (d.org !== undefined) {
    el.org.textContent = d.org ? d.org + (d.role ? ` · ${d.role}` : "") : "";
    el.org.title = d.org || "";
  }
  if (d.model) {
    state.model = d.model;
    el.model.textContent = d.model;
  }
  if (d.usedPct != null) {
    state.ctxPct = d.usedPct;
    el.ctx.textContent = `ctx ${Math.round(d.usedPct)}%`;
  }
  if (d.totals) {
    const t = d.totals;
    // session total comes from the server-side running tally (survives restarts
    // for today/all-time; session is per server run).
    if (t.session) {
      state.sessionTotal = t.session.tokens;
      state.sessionCost = t.session.cost;
    }
    if (t.today) el.today.textContent = `today: ${fmt(t.today.tokens)} tok · ${usd(t.today.cost)}`;
    if (t.allTime) el.alltime.textContent = `all-time: ${fmt(t.allTime.tokens)} tok · ${usd(t.allTime.cost)}`;
  }
  if (d.day) state.day = d.day;
  if (d.leaderboard) state.boards.tokens = d.leaderboard;
  if (d.leaderboardCost) state.boards.cost = d.leaderboardCost;
  if (d.leaderboard || d.leaderboardCost) renderBoard();
}

function setBoardView(view) {
  state.boardView = view;
  el.tabTokens.classList.toggle("active", view === "tokens");
  el.tabCost.classList.toggle("active", view === "cost");
  renderBoard();
}

function renderBoard(flashTs) {
  const cost = state.boardView === "cost";
  const list = state.boards[state.boardView] || [];
  if (!list.length) {
    el.board.innerHTML = `<li class="empty">No jackpots yet — go spend some tokens.</li>`;
    return;
  }
  el.board.innerHTML = list
    .map((e) => {
      const flash = flashTs && e.ts === flashTs ? " flash" : "";
      const primary = cost ? usd(e.cost) : fmt(e.tokens);
      const meta = cost ? `${fmt(e.tokens)} tok` : usd(e.cost);
      const label = e.label ? `<span class="label">${esc(e.label)}</span>` : `<span class="label dimlabel">— no prompt captured —</span>`;
      return `<li class="${flash.trim()}"><span class="toks">${primary}</span><span class="meta">${meta}</span>${label}</li>`;
    })
    .join("");
}

function fireBurst(d) {
  const tokens = Math.max(0, Math.round(d.turnTokens || 0));
  if (tokens <= 0) return;
  stopAlert(); // Claude is generating again → silence any "needs input" alarm
  const turnCost = Number(d.cost) || 0;

  const n = coinCount(tokens);
  const inten = intensity(tokens);
  let tier = tierOf(inten);
  const rank = d.rank || 0; // 1-based leaderboard position, 0 = didn't place
  const isTopRecord = rank === 1;
  if (isTopRecord) tier = 4; // a brand-new #1 always reads as JACKPOT
  state.lastTier = tier;

  // refresh totals / leaderboard pills, flashing this turn's new entry
  applyState(d);
  renderBoard(d.entryTs);

  // shake / glow / drawer / bell — records crank everything up
  const recordBoost = isTopRecord ? 1.5 : 1;
  state.shake = Math.max(state.shake, (6 + inten * 26) * recordBoost);
  state.glow = 1;
  state.drawer = 1;
  state.bell = 1;

  // reels spin; jackpot lands on a matched triple
  const now = performance.now();
  const jackpot = tier >= 4;
  const matched = Math.floor(rand(3, REEL_SYMBOLS.length)); // a "good" symbol
  state.reels.forEach((r, i) => {
    r.spinUntil = now + 650 + inten * 1400 + i * 220;
    r.speed = 0.6 + inten * 0.9;
    r.target = jackpot ? matched : Math.floor(rand(0, REEL_SYMBOLS.length));
  });

  // coin fountain
  const g = geom();
  const mouthX = g.cx;
  const mouthY = g.by + g.bh * 0.72;
  for (let i = 0; i < n; i++) {
    const ang = -Math.PI / 2 + rand(-0.9, 0.9);
    const power = rand(5, 11) * (0.8 + inten);
    coins.push({
      x: mouthX + rand(-30, 30) * g.s,
      y: mouthY,
      vx: Math.cos(ang) * power + rand(-2, 2),
      vy: Math.sin(ang) * power - rand(2, 5),
      r: rand(9, 16) * g.s,
      rot: rand(0, Math.PI * 2),
      vrot: rand(-0.3, 0.3),
      flip: rand(0, Math.PI * 2),
      vflip: rand(0.2, 0.5),
      life: 1,
      hue: rand(-8, 14),
    });
  }
  if (coins.length > 1100) coins.splice(0, coins.length - 1100);

  // extra gold burst of dust on big wins
  if (tier >= 3) spawnDustBurst(g, inten);

  // popup label
  let tierName = ["", "", "", "BIG WIN", "💎 JACKPOT 💎"][tier] || "";
  if (isTopRecord) tierName = "🏆 NEW RECORD!";
  state.popup = {
    text: `+${fmt(tokens)} tokens · ${usd(turnCost)}` + (tierName ? `   ${tierName}` : ""),
    life: 1,
    color: isTopRecord ? "#fff2b0" : tier >= 4 ? "#ffe25a" : tier >= 3 ? "#ffcf3f" : "#bfe9ff",
  };

  // ticker
  const u = d.usage || {};
  const promptBit = d.promptLabel ? ` <span style="color:#cfe9da">“${esc(d.promptLabel)}”</span>` : "";
  el.lastEvent.innerHTML =
    `<b>cha-ching!</b> +${fmt(tokens)} tokens · <b style="color:#ffe9a8">${usd(turnCost)}</b> on <b>${esc(d.model || state.model)}</b>` +
    promptBit +
    ` <span style="color:#8a93ad">(out ${fmt(u.output)} · cache+ ${fmt(u.cacheCreate)} · in ${fmt(u.input)} · cache-read ${fmt(u.cacheRead)})</span>` +
    (rank ? ` <span style="color:#ffcf3f">— #${rank} jackpot!</span>` : "");

  playChaChing(n, inten);
  if (isTopRecord) playFanfare();
}

// ── render loop ──────────────────────────────────────────────────────────────
let last = performance.now();
function frame(now) {
  const dt = Math.min(40, now - last) / 16.6667;
  last = now;
  step(dt, now);
  draw(now);
  requestAnimationFrame(frame);
}

function step(dt, now) {
  // decays
  state.shake *= Math.pow(0.86, dt);
  state.glow *= Math.pow(0.94, dt);
  state.bell *= Math.pow(0.9, dt);
  state.drawer += ((coins.length > 0 ? 1 : 0) - state.drawer) * 0.1 * dt;
  if (state.popup) {
    state.popup.life -= 0.012 * dt;
    if (state.popup.life <= 0) state.popup = null;
  }

  // coins physics
  for (let i = coins.length - 1; i >= 0; i--) {
    const c = coins[i];
    c.vy += 0.42 * dt; // gravity
    c.x += c.vx * dt;
    c.y += c.vy * dt;
    c.vx *= Math.pow(0.995, dt);
    c.rot += c.vrot * dt;
    c.flip += c.vflip * dt;
    // occasional sparkle trail — more gold shimmer in the air
    if (sparks.length < 1500 && Math.random() < 0.06) {
      sparks.push({ x: c.x, y: c.y, r: rand(0.8, 2), vx: rand(-0.3, 0.3), vy: rand(-0.3, 0.3), life: rand(0.4, 0.9), color: "#ffe9a8" });
    }
    if (c.y - c.r > H + 40) {
      coins.splice(i, 1);
    }
  }

  // ambient + burst dust
  for (let i = dust.length - 1; i >= 0; i--) {
    const m = dust[i];
    m.x += m.vx * dt;
    m.y += m.vy * dt;
    m.tw += 0.05 * dt;
    if (m.decay) {
      m.a -= m.decay * dt;
      if (m.a <= 0) {
        dust.splice(i, 1);
        continue;
      }
    } else {
      // wrap ambient motes
      if (m.y < -5) m.y = H + 5;
      if (m.x < -5) m.x = W + 5;
      else if (m.x > W + 5) m.x = -5;
    }
  }

  // reels settle
  for (const r of state.reels) {
    if (now < r.spinUntil) {
      r.offset += r.speed * dt;
    } else if (r.target != null) {
      r.symbol = r.target;
      r.target = null;
    }
  }

  // sparks
  for (let i = sparks.length - 1; i >= 0; i--) {
    const s = sparks[i];
    s.life -= 0.04 * dt;
    s.x += s.vx * dt;
    s.y += s.vy * dt;
    if (s.life <= 0) sparks.splice(i, 1);
  }
}

function draw(now) {
  ctx.clearRect(0, 0, W, H);
  const g = geom();

  drawVignette();
  drawDust();

  ctx.save();
  const sh = state.shake;
  if (sh > 0.2) ctx.translate(rand(-sh, sh), rand(-sh, sh));

  drawStand(g);
  drawBody(g, now);
  drawCrest(g);
  drawReels(g, now);
  drawScreen(g);
  drawKeys(g);
  drawDrawer(g);
  drawLever(g, now);
  drawBell(g);

  // coins drawn over the register so they spill toward the viewer
  for (const c of coins) drawCoin(c);
  for (const s of sparks) {
    ctx.globalAlpha = clamp(s.life, 0, 1);
    ctx.fillStyle = s.color;
    ctx.beginPath();
    ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  drawPopup(g);
  ctx.restore();
}

// ── drawing helpers ──────────────────────────────────────────────────────────
function rr(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawVignette() {
  // warm gold radial glow from the floor, intensifying with recent wins
  const base = 0.06 + state.glow * 0.18;
  const grd = ctx.createRadialGradient(W / 2, H * 0.62, 0, W / 2, H * 0.62, Math.max(W, H) * 0.7);
  grd.addColorStop(0, `rgba(255,200,70,${base})`);
  grd.addColorStop(1, "rgba(255,200,70,0)");
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, W, H);
}

function drawDust() {
  for (const m of dust) {
    const tw = 0.6 + 0.4 * Math.sin(m.tw);
    ctx.globalAlpha = clamp(m.a * tw, 0, 1);
    ctx.fillStyle = "#ffe6a0";
    ctx.beginPath();
    ctx.arc(m.x, m.y, m.r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function drawStand(g) {
  const { bx, by, bw, bh, s } = g;
  const baseY = by + bh - 10 * s;
  const baseW = bw + 56 * s;
  const baseX = g.cx - baseW / 2;
  const bh2 = 54 * s;
  // green marble slab
  const mg = ctx.createLinearGradient(0, baseY, 0, baseY + bh2);
  mg.addColorStop(0, "#1e6b50");
  mg.addColorStop(0.5, "#124234");
  mg.addColorStop(1, "#0c2a20");
  ctx.fillStyle = mg;
  rr(baseX, baseY, baseW, bh2, 10 * s);
  ctx.fill();
  // marble veining
  ctx.save();
  rr(baseX, baseY, baseW, bh2, 10 * s);
  ctx.clip();
  ctx.strokeStyle = "rgba(180,255,220,0.12)";
  ctx.lineWidth = 1 * s;
  for (let i = 0; i < 5; i++) {
    ctx.beginPath();
    const yy = baseY + rand(4, bh2 - 4);
    ctx.moveTo(baseX, yy);
    ctx.bezierCurveTo(baseX + baseW * 0.3, yy + rand(-8, 8) * s, baseX + baseW * 0.6, yy + rand(-8, 8) * s, baseX + baseW, yy + rand(-6, 6) * s);
    ctx.stroke();
  }
  ctx.restore();
  // gold rim on the base
  ctx.strokeStyle = brassStroke();
  ctx.lineWidth = 2.5 * s;
  rr(baseX, baseY, baseW, bh2, 10 * s);
  ctx.stroke();
  // little feet
  ctx.fillStyle = "#0a1f18";
  rr(baseX + 14 * s, baseY + bh2 - 4 * s, 30 * s, 12 * s, 4 * s);
  ctx.fill();
  rr(baseX + baseW - 44 * s, baseY + bh2 - 4 * s, 30 * s, 12 * s, 4 * s);
  ctx.fill();
}

// shared brass fill for vertical surfaces
function brassFill(x, y0, y1) {
  const grd = ctx.createLinearGradient(x, y0, x, y1);
  grd.addColorStop(0, "#fff3cf");
  grd.addColorStop(0.18, "#f3cd71");
  grd.addColorStop(0.5, "#d9a93a");
  grd.addColorStop(0.82, "#9c7322");
  grd.addColorStop(1, "#6f4f15");
  return grd;
}
function brassStroke() {
  return "#7a5818";
}

function drawBody(g, now) {
  const { bx, by, bw, bh, s } = g;
  // glow halo
  if (state.glow > 0.02) {
    ctx.save();
    ctx.shadowColor = state.lastTier >= 4 ? "rgba(255,226,90," + state.glow + ")" : "rgba(255,207,63," + state.glow + ")";
    ctx.shadowBlur = 40 + 70 * state.glow;
    rr(bx, by, bw, bh, 22 * s);
    ctx.fillStyle = "#1a1408";
    ctx.fill();
    ctx.restore();
  }

  // brass cabinet
  ctx.fillStyle = brassFill(bx, by, by + bh);
  rr(bx, by, bw, bh, 22 * s);
  ctx.fill();
  // soft top highlight sheen
  const sheen = ctx.createLinearGradient(bx, by, bx + bw, by);
  sheen.addColorStop(0, "rgba(255,255,255,0)");
  sheen.addColorStop(0.5, "rgba(255,255,255,0.18)");
  sheen.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = sheen;
  rr(bx, by, bw, bh * 0.4, 22 * s);
  ctx.fill();
  ctx.lineWidth = 3 * s;
  ctx.strokeStyle = brassStroke();
  rr(bx, by, bw, bh, 22 * s);
  ctx.stroke();

  // inner engraved gold border
  ctx.strokeStyle = "rgba(110,80,20,0.7)";
  ctx.lineWidth = 1.5 * s;
  rr(bx + 9 * s, by + 9 * s, bw - 18 * s, bh - 18 * s, 16 * s);
  ctx.stroke();
  ctx.strokeStyle = "rgba(255,244,200,0.5)";
  rr(bx + 12 * s, by + 12 * s, bw - 24 * s, bh - 24 * s, 14 * s);
  ctx.stroke();

  // green ornamental side panels
  drawSidePanel(bx + 14 * s, by + 16 * s, 22 * s, bh - 32 * s, s);
  drawSidePanel(bx + bw - 36 * s, by + 16 * s, 22 * s, bh - 32 * s, s);

  // brass rivets around the frame
  ctx.fillStyle = "#caa23e";
  const rivet = (x, y) => {
    ctx.beginPath();
    ctx.arc(x, y, 2.6 * s, 0, Math.PI * 2);
    ctx.fill();
  };
  for (let i = 0; i <= 6; i++) {
    rivet(bx + 16 * s + ((bw - 32 * s) * i) / 6, by + 14 * s);
    rivet(bx + 16 * s + ((bw - 32 * s) * i) / 6, by + bh - 14 * s);
  }
}

function drawSidePanel(x, y, w, h, s) {
  const g = ctx.createLinearGradient(x, y, x + w, y);
  g.addColorStop(0, "#0c3325");
  g.addColorStop(0.5, "#1a6147");
  g.addColorStop(1, "#0c3325");
  ctx.fillStyle = g;
  rr(x, y, w, h, 8 * s);
  ctx.fill();
  ctx.strokeStyle = brassStroke();
  ctx.lineWidth = 2 * s;
  ctx.stroke();
  // a few engraved diamonds
  ctx.strokeStyle = "rgba(255,230,160,0.35)";
  ctx.lineWidth = 1 * s;
  for (let i = 0; i < 4; i++) {
    const cy = y + h * (0.16 + i * 0.22);
    ctx.beginPath();
    ctx.moveTo(x + w / 2, cy - 6 * s);
    ctx.lineTo(x + w - 5 * s, cy);
    ctx.lineTo(x + w / 2, cy + 6 * s);
    ctx.lineTo(x + 5 * s, cy);
    ctx.closePath();
    ctx.stroke();
  }
}

// ornate brass crown on top, with a "$" medallion that lights with the bell
function drawCrest(g) {
  const { bx, by, bw, s } = g;
  const cw = bw * 0.5;
  const x = g.cx - cw / 2;
  const h = 40 * s;
  const y = by - h + 6 * s;
  // scalloped brass crown
  ctx.fillStyle = brassFill(x, y, y + h);
  ctx.beginPath();
  ctx.moveTo(x, y + h);
  ctx.quadraticCurveTo(x, y + 8 * s, x + 16 * s, y + 8 * s);
  ctx.quadraticCurveTo(g.cx - 14 * s, y - 6 * s, g.cx, y - 14 * s);
  ctx.quadraticCurveTo(g.cx + 14 * s, y - 6 * s, x + cw - 16 * s, y + 8 * s);
  ctx.quadraticCurveTo(x + cw, y + 8 * s, x + cw, y + h);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = brassStroke();
  ctx.lineWidth = 2 * s;
  ctx.stroke();
  // medallion
  const my = y - 2 * s;
  const lit = state.bell > 0.05;
  ctx.beginPath();
  ctx.arc(g.cx, my, 13 * s, 0, Math.PI * 2);
  ctx.fillStyle = "#0c3a2a";
  if (lit) {
    ctx.shadowColor = "rgba(255,210,80," + state.bell + ")";
    ctx.shadowBlur = 24 * state.bell;
  }
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = brassStroke();
  ctx.lineWidth = 2 * s;
  ctx.stroke();
  ctx.fillStyle = "#ffd86b";
  ctx.font = `bold ${Math.round(16 * s)}px Georgia, serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("$", g.cx, my + 1 * s);
  ctx.textAlign = "start";
}

// rows of round keys across the lower front, classic register style
function drawKeys(g) {
  const { bx, by, bw, bh, s } = g;
  const rows = 2,
    cols = 6;
  const areaY = by + 186 * s;
  const areaH = bh - 186 * s - 40 * s;
  const padX = 34 * s;
  const gapX = (bw - padX * 2) / cols;
  const gapY = areaH / rows;
  const kr = Math.min(gapX, gapY) * 0.32;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = bx + padX + gapX * (c + 0.5);
      const y = areaY + gapY * (r + 0.5);
      // brass rim
      ctx.beginPath();
      ctx.arc(x, y, kr + 2.5 * s, 0, Math.PI * 2);
      ctx.fillStyle = "#caa23e";
      ctx.fill();
      // key face — alternate cream / green
      const green = (r + c) % 2 === 0;
      const fg = ctx.createRadialGradient(x - kr * 0.3, y - kr * 0.3, kr * 0.1, x, y, kr);
      if (green) {
        fg.addColorStop(0, "#3aa17a");
        fg.addColorStop(1, "#0f4732");
      } else {
        fg.addColorStop(0, "#fff7e4");
        fg.addColorStop(1, "#d9c79a");
      }
      ctx.fillStyle = fg;
      ctx.beginPath();
      ctx.arc(x, y, kr, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function drawScreen(g) {
  const { bx, by, bw, s } = g;
  const w = bw * 0.62,
    h = 58 * s;
  const x = bx + (bw - w) / 2,
    y = by + 20 * s;
  // gold frame
  ctx.fillStyle = brassFill(x - 4 * s, y - 4 * s, y + h + 4 * s);
  rr(x - 5 * s, y - 5 * s, w + 10 * s, h + 10 * s, 10 * s);
  ctx.fill();
  ctx.strokeStyle = brassStroke();
  ctx.lineWidth = 2 * s;
  ctx.stroke();
  // dark green glass
  const gg = ctx.createLinearGradient(x, y, x, y + h);
  gg.addColorStop(0, "#0a3024");
  gg.addColorStop(1, "#05201a");
  ctx.fillStyle = gg;
  rr(x, y, w, h, 6 * s);
  ctx.fill();

  // "TOTAL" label
  ctx.fillStyle = "#7fcfa8";
  ctx.font = `${Math.round(9 * s)}px ui-monospace, monospace`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("• T O T A L •", x + w / 2, y + 11 * s);
  // amount in glowing gold
  ctx.fillStyle = "#ffd86b";
  ctx.font = `bold ${Math.round(21 * s)}px ui-monospace, monospace`;
  ctx.shadowColor = "#ffd86b99";
  ctx.shadowBlur = 10 * s;
  ctx.fillText(`${fmt(state.sessionTotal)} TOK`, x + w / 2, y + h / 2 + 2 * s);
  ctx.shadowBlur = 0;
  ctx.fillStyle = "#9fe6c2";
  ctx.font = `${Math.round(12 * s)}px ui-monospace, monospace`;
  ctx.fillText(`${usd(state.sessionCost)} this session`, x + w / 2, y + h - 10 * s);
  ctx.textAlign = "start";
}

function drawReels(g, now) {
  const { bx, by, bw, bh, s } = g;
  const win = { w: bw * 0.62, h: 90 * s };
  const x = bx + (bw - win.w) / 2;
  const y = by + 90 * s;
  // brass bezel around the slot window
  ctx.fillStyle = brassFill(x - 7 * s, y - 7 * s, y + win.h + 7 * s);
  rr(x - 8 * s, y - 8 * s, win.w + 16 * s, win.h + 16 * s, 14 * s);
  ctx.fill();
  ctx.strokeStyle = brassStroke();
  ctx.lineWidth = 2 * s;
  ctx.stroke();
  // dark green felt window interior
  const wg = ctx.createLinearGradient(x, y, x, y + win.h);
  wg.addColorStop(0, "#06251b");
  wg.addColorStop(1, "#04140e");
  ctx.fillStyle = wg;
  rr(x, y, win.w, win.h, 8 * s);
  ctx.fill();

  const cellW = win.w / 3;
  ctx.save();
  rr(x, y, win.w, win.h, 10 * s);
  ctx.clip();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `${Math.round(46 * s)}px serif`;
  state.reels.forEach((r, i) => {
    const cxr = x + cellW * (i + 0.5);
    const spinning = now < r.spinUntil;
    if (spinning) {
      // show a blurred strip of cycling symbols
      const o = (r.offset % 1) * 1;
      for (let k = -1; k <= 1; k++) {
        const idx = (Math.floor(r.offset) + k + REEL_SYMBOLS.length * 4) % REEL_SYMBOLS.length;
        const yy = y + win.h / 2 + (k - o) * (win.h * 0.62);
        ctx.globalAlpha = 0.55;
        ctx.fillText(REEL_SYMBOLS[idx], cxr, yy);
      }
      ctx.globalAlpha = 1;
    } else {
      ctx.fillText(REEL_SYMBOLS[r.symbol], cxr, y + win.h / 2);
    }
    if (i < 2) {
      ctx.strokeStyle = "#ffffff14";
      ctx.lineWidth = 1 * s;
      ctx.beginPath();
      ctx.moveTo(x + cellW * (i + 1), y);
      ctx.lineTo(x + cellW * (i + 1), y + win.h);
      ctx.stroke();
    }
  });
  ctx.restore();
  ctx.textAlign = "start";
}

function drawDrawer(g) {
  const { bx, by, bw, bh, s } = g;
  const open = state.drawer;
  const dw = bw * 0.86,
    dh = 34 * s;
  const x = bx + (bw - dw) / 2;
  const y = by + bh - 24 * s + open * 26 * s;
  // brass drawer face with a green inset
  ctx.fillStyle = brassFill(x, y, y + dh);
  rr(x, y, dw, dh, 6 * s);
  ctx.fill();
  ctx.strokeStyle = brassStroke();
  ctx.lineWidth = 2 * s;
  ctx.stroke();
  const ig = ctx.createLinearGradient(x, y, x, y + dh);
  ig.addColorStop(0, "#14543f");
  ig.addColorStop(1, "#0c3325");
  ctx.fillStyle = ig;
  rr(x + 8 * s, y + 6 * s, dw - 16 * s, dh - 12 * s, 4 * s);
  ctx.fill();
  // handle
  ctx.fillStyle = "#ffe9a8";
  rr(x + dw / 2 - 24 * s, y + dh / 2 - 3 * s, 48 * s, 6 * s, 3 * s);
  ctx.fill();
  // open cavity glow
  if (open > 0.05) {
    ctx.fillStyle = `rgba(255,207,63,${0.18 * open})`;
    rr(x + 6 * s, y - 10 * s * open, dw - 12 * s, 12 * s * open, 4 * s);
    ctx.fill();
  }
}

function drawLever(g, now) {
  const { bx, by, bh, s } = g;
  const baseX = bx - 6 * s;
  const baseY = by + bh * 0.4;
  const spinning = state.reels.some((r) => now < r.spinUntil);
  const pull = spinning ? 0.5 : 0;
  // brass mounting plate
  ctx.fillStyle = brassFill(baseX - 8 * s, baseY - 8 * s, baseY + 8 * s);
  ctx.beginPath();
  ctx.arc(baseX, baseY, 9 * s, 0, Math.PI * 2);
  ctx.fill();
  // brass arm
  const tipX = baseX - 14 * s;
  const tipY = baseY - (50 - pull * 40) * s;
  ctx.strokeStyle = "#d9b24a";
  ctx.lineWidth = 6 * s;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(baseX, baseY);
  ctx.lineTo(tipX, tipY);
  ctx.stroke();
  // red knob with highlight
  const kg = ctx.createRadialGradient(tipX - 3 * s, tipY - 3 * s, 1, tipX, tipY, 11 * s);
  kg.addColorStop(0, "#ff8a93");
  kg.addColorStop(1, "#c0121f");
  ctx.fillStyle = kg;
  ctx.beginPath();
  ctx.arc(tipX, tipY, 11 * s, 0, Math.PI * 2);
  ctx.fill();
}

function drawBell(g) {
  const { bx, by, bw, s } = g;
  const r = 14 * s;
  const x = bx + bw - 26 * s;
  const y = by + 30 * s;
  const flash = state.bell;
  // brass dome bell, lights up when it rings
  const dg = ctx.createRadialGradient(x - 4 * s, y - 6 * s, 1, x, y, r);
  if (flash > 0.05) {
    dg.addColorStop(0, "#fff3c0");
    dg.addColorStop(1, "#e0a72a");
    ctx.shadowColor = "rgba(255,210,80," + flash + ")";
    ctx.shadowBlur = 30 * flash;
  } else {
    dg.addColorStop(0, "#f0d27a");
    dg.addColorStop(1, "#a07e2a");
  }
  ctx.fillStyle = dg;
  ctx.beginPath();
  ctx.arc(x, y, r, Math.PI, 0);
  ctx.lineTo(x + r, y);
  ctx.lineTo(x - r, y);
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = brassStroke();
  ctx.lineWidth = 1.5 * s;
  ctx.stroke();
  // little knob on top
  ctx.fillStyle = "#d9b24a";
  ctx.beginPath();
  ctx.arc(x, y - r, 2.5 * s, 0, Math.PI * 2);
  ctx.fill();
}

function drawCoin(c) {
  ctx.save();
  ctx.translate(c.x, c.y);
  ctx.rotate(c.rot);
  const flip = Math.cos(c.flip);
  const rx = Math.max(2, Math.abs(flip) * c.r);
  const grd = ctx.createLinearGradient(-rx, -c.r, rx, c.r);
  grd.addColorStop(0, `hsl(${46 + c.hue},95%,72%)`);
  grd.addColorStop(0.5, `hsl(${44 + c.hue},92%,55%)`);
  grd.addColorStop(1, `hsl(${40 + c.hue},90%,42%)`);
  ctx.fillStyle = grd;
  ctx.beginPath();
  ctx.ellipse(0, 0, rx, c.r, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "rgba(120,80,0,0.5)";
  ctx.lineWidth = 1.5;
  ctx.stroke();
  if (rx > c.r * 0.4) {
    ctx.fillStyle = "rgba(110,70,0,0.85)";
    ctx.font = `bold ${Math.round(c.r * 1.1)}px ui-monospace, monospace`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("$", 0, 1);
  }
  ctx.restore();
}

function drawPopup(g) {
  if (!state.popup) return;
  const p = state.popup;
  const { cx, by, s } = g;
  const a = clamp(p.life * 1.4, 0, 1);
  const rise = (1 - p.life) * 60 * s;
  ctx.save();
  ctx.globalAlpha = a;
  ctx.fillStyle = p.color;
  ctx.font = `bold ${Math.round(30 * s)}px ui-monospace, monospace`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.shadowColor = "#000a";
  ctx.shadowBlur = 12;
  ctx.fillText(p.text, cx, by - 26 * s - rise);
  ctx.restore();
}

// ── audio (Web Audio synth, no asset files) ──────────────────────────────────
let audio = null;
function initAudio() {
  if (audio) return;
  audio = new (window.AudioContext || window.webkitAudioContext)();
}
function tone(freq, t0, dur, type, gain) {
  const o = audio.createOscillator();
  const g = audio.createGain();
  o.type = type;
  o.frequency.value = freq;
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(gain, t0 + 0.004);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(g).connect(audio.destination);
  o.start(t0);
  o.stop(t0 + dur + 0.02);
}
function playChaChing(n, inten) {
  if (!audio) return;
  const t = audio.currentTime;
  // the "cha-ching" two-note bell
  tone(1318.5, t, 0.18, "triangle", 0.25); // E6
  tone(1760.0, t + 0.09, 0.32, "triangle", 0.28); // A6
  tone(880.0, t + 0.09, 0.32, "sine", 0.12);
  // coin clinks spread across the fountain
  const clinks = Math.min(n, 36);
  const span = 0.5 + inten * 0.8;
  for (let i = 0; i < clinks; i++) {
    const tt = t + 0.05 + Math.random() * span;
    tone(rand(2200, 4200), tt, 0.06, "square", 0.05);
  }
}
function playFanfare() {
  if (!audio) return;
  const t = audio.currentTime;
  // a rising major arpeggio for a brand-new record
  [523.25, 659.25, 783.99, 1046.5, 1318.5].forEach((f, i) => {
    tone(f, t + i * 0.1, 0.45, "triangle", 0.22);
  });
}
function playBuzzer(volScale = 1) {
  if (!audio) return;
  const peak = 0.45 * clamp(volScale, 0, 1); // escalating loudness
  const t = audio.currentTime;
  // three harsh low buzzes — the "you're needed" klaxon
  for (let k = 0; k < 3; k++) {
    const t0 = t + k * 0.32;
    const o = audio.createOscillator();
    const g = audio.createGain();
    const lfo = audio.createOscillator(); // amplitude wobble for a raspy buzz
    const lfoGain = audio.createGain();
    o.type = "sawtooth";
    o.frequency.value = 220;
    lfo.frequency.value = 28;
    lfoGain.gain.value = 0.18;
    lfo.connect(lfoGain).connect(g.gain);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(peak, t0 + 0.01);
    g.gain.setValueAtTime(peak, t0 + 0.22);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.27);
    o.connect(g).connect(audio.destination);
    o.start(t0);
    lfo.start(t0);
    o.stop(t0 + 0.3);
    lfo.stop(t0 + 0.3);
  }
}

function playDayChime() {
  if (!audio) return;
  const t = audio.currentTime;
  // gentle bright triad sweep — "a fresh day, the register resets"
  [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => {
    tone(f, t + i * 0.16, 1.1, "sine", 0.16);
    tone(f * 2, t + i * 0.16, 0.7, "triangle", 0.05); // soft shimmer
  });
}
function onNewDay(d) {
  state.day = d.date;
  // today's running total resets to zero at the rollover
  el.today.textContent = `today: 0 tok · $0.00`;
  const prev = d.previous || { tokens: 0, cost: 0 };
  state.popup = {
    text: `🌅 NEW DAY — yesterday: ${fmt(prev.tokens)} tok · ${usd(prev.cost)}`,
    life: 1.6,
    color: "#bfe9ff",
  };
  el.lastEvent.innerHTML = `<b>🌅 New day.</b> Today's total reset. Yesterday: <b style="color:#ffe9a8">${fmt(prev.tokens)} tokens · ${usd(prev.cost)}</b>.`;
  playDayChime();
}

// ── siren (Claude needs your input) ──────────────────────────────────────────
// Loops the buzzer every 5s with escalating volume until the prompt is answered.
// Stop signals: you submit a prompt (UserPromptSubmit → alertstop), Claude
// resumes (a token burst), any click/keypress, or a ~60s safety cap.
const ALERT_PERIOD_MS = 5000;
const ALERT_MAX_ITERS = 12; // ≈60s — never blare forever
let alertActive = false;
let alertInterval = null;
let alertIteration = 0;

function showSiren(d) {
  el.sirenText.textContent = (d.message || "Claude needs your input").toUpperCase();
  el.siren.classList.add("on");
  if (alertActive) return; // already blaring — just refreshed the message
  alertActive = true;
  alertIteration = 0;
  buzzStep();
  alertInterval = setInterval(buzzStep, ALERT_PERIOD_MS);
}
function buzzStep() {
  alertIteration++;
  // ramp from a soft 0.4 up to full volume over the first ~5 cycles
  const vol = Math.min(1, 0.4 + 0.15 * (alertIteration - 1));
  playBuzzer(vol);
  el.siren.style.setProperty("--siren-intensity", vol.toFixed(2));
  if (alertIteration >= ALERT_MAX_ITERS) stopAlert();
}
function stopAlert() {
  if (!alertActive && !el.siren.classList.contains("on")) return;
  alertActive = false;
  if (alertInterval) clearInterval(alertInterval);
  alertInterval = null;
  el.siren.classList.remove("on");
  el.siren.style.setProperty("--siren-intensity", "0");
}
// any click or key silences it (you've seen it)
window.addEventListener("pointerdown", stopAlert);
window.addEventListener("keydown", stopAlert);

// ── SSE wiring ───────────────────────────────────────────────────────────────
function connect() {
  const es = new EventSource("/events");
  es.addEventListener("hello", (e) => {
    el.connDot.classList.add("live");
    try {
      applyState(JSON.parse(e.data));
    } catch {}
  });
  es.addEventListener("state", (e) => {
    try {
      applyState(JSON.parse(e.data));
    } catch {}
  });
  es.addEventListener("burst", (e) => {
    try {
      fireBurst(JSON.parse(e.data));
    } catch {}
  });
  es.addEventListener("alert", (e) => {
    try {
      showSiren(JSON.parse(e.data));
    } catch {
      showSiren({});
    }
  });
  es.addEventListener("newday", (e) => {
    try {
      onNewDay(JSON.parse(e.data));
    } catch {}
  });
  es.addEventListener("alertstop", () => stopAlert()); // you answered the prompt
  es.onerror = () => {
    el.connDot.classList.remove("live");
  };
  es.onopen = () => el.connDot.classList.add("live");
}

// ── utils ────────────────────────────────────────────────────────────────────
function fmt(n) {
  n = Math.round(Number(n) || 0);
  if (n >= 1_000_000) return (n / 1e6).toFixed(2) + "M";
  if (n >= 10_000) return Math.round(n / 1000) + "k";
  if (n >= 1000) return (n / 1000).toFixed(1) + "k";
  return String(n);
}
function usd(n) {
  n = Number(n) || 0;
  if (n >= 1000) return "$" + n.toFixed(0);
  if (n >= 1) return "$" + n.toFixed(2);
  if (n >= 0.01) return "$" + n.toFixed(3);
  return "$" + n.toFixed(4);
}
function esc(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
}

// ── boot ─────────────────────────────────────────────────────────────────────
el.enableSound.addEventListener("click", () => {
  initAudio();
  el.soundGate.classList.add("hidden");
});
el.tabTokens.addEventListener("click", () => setBoardView("tokens"));
el.tabCost.addEventListener("click", () => setBoardView("cost"));
// allow muted viewing too: dismiss on any key
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") el.soundGate.classList.add("hidden");
});

// URL conveniences: ?board=cost picks the cost leaderboard; ?nogate skips the
// click-to-enable-sound overlay (handy for an always-on dashboard, muted).
const params = new URLSearchParams(location.search);
if (params.get("board") === "cost") setBoardView("cost");
if (params.has("nogate")) el.soundGate.classList.add("hidden");

resize();
requestAnimationFrame(frame);
connect();
