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
  profilesList: document.getElementById("profiles-list"),
  tabTokens: document.getElementById("tab-tokens"),
  tabCost: document.getElementById("tab-cost"),
  lastEvent: document.getElementById("last-event"),
  connDot: document.getElementById("conn-dot"),
  soundGate: document.getElementById("sound-gate"),
  enableSound: document.getElementById("enable-sound"),
  siren: document.getElementById("siren"),
  sirenText: document.getElementById("siren-text"),
  mute: document.getElementById("mute"),
  clearAlert: document.getElementById("clear-alert"),
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
  seedRain();
}
window.addEventListener("resize", resize);

// ── world state ─────────────────────────────────────────────────────────────
const REEL_SYMBOLS = ["🍒", "🪙", "💵", "⭐", "💎", "7️⃣"];
const coins = [];
let sparks = [];
const dust = []; // ambient floating gold motes
const rain = []; // coins endlessly pouring from the vault ceiling (background)

// The register stays dormant until the user clicks "enable" (or ?nogate): the
// board still tracks live totals, but no bursts/spins/siren/sound fire. Spend
// that lands while dormant is banked so we can replay one catch-up burst on
// enable. See the sound-gate handler in the boot section.
let armed = false;
const pending = { tokens: 0, cost: 0 };

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

// ── per-profile "voice" (colour + distinct sound) ────────────────────────────
// Each Claude profile gets its own hue + sound so work vs personal are instantly
// distinguishable by ear and eye. Known profiles are hand-tuned; unknown ones
// derive a stable voice from a hash of the name.
const PROFILE_VOICES = {
  personal: { hue: 45, chMul: 0.84, buzz: 175, wave: "triangle" }, // warm gold, lower
  work: { hue: 205, chMul: 1.22, buzz: 300, wave: "sawtooth" }, // cool blue, higher/harsher
  default: { hue: 140, chMul: 1.0, buzz: 220, wave: "sawtooth" },
};
const _voiceCache = new Map();
function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}
function voiceFor(profile) {
  const key = profile || "default";
  if (_voiceCache.has(key)) return _voiceCache.get(key);
  let v = PROFILE_VOICES[key];
  if (!v) {
    const h = hashStr(key);
    v = { hue: h % 360, chMul: 0.8 + (h % 9) * 0.06, buzz: 160 + (h % 6) * 35, wave: h & 1 ? "sawtooth" : "square" };
  }
  const out = { ...v, name: key, color: `hsl(${v.hue},85%,62%)` };
  _voiceCache.set(key, out);
  return out;
}

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

// ── bank-vault backdrop + coins pouring from the ceiling ─────────────────────
function resetRainCoin(c, atTop) {
  const depth = Math.random(); // 0 = far/small/slow, 1 = near/big/fast (parallax)
  c.x = Math.random() * W;
  c.y = atTop ? rand(-40, -4) : Math.random() * H;
  c.r = 4 + depth * 9;
  c.vy = 1.3 + depth * 3.4;
  c.vx = rand(-0.3, 0.3);
  c.rot = rand(0, Math.PI * 2);
  c.vrot = rand(-0.12, 0.12);
  c.flip = rand(0, Math.PI * 2);
  c.vflip = rand(0.05, 0.2);
  c.alpha = 0.22 + depth * 0.5;
}
function seedRain() {
  rain.length = 0;
  const count = clamp(Math.round(W / 14), 30, 140);
  for (let i = 0; i < count; i++) {
    const c = {};
    resetRainCoin(c, false);
    rain.push(c);
  }
}
function goldDisc(x, y, r, flipCos, rot) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rot);
  const rx = Math.max(1.2, Math.abs(flipCos) * r);
  const grd = ctx.createLinearGradient(-rx, -r, rx, r);
  grd.addColorStop(0, "#ffe9a8");
  grd.addColorStop(0.5, "#e6b53e");
  grd.addColorStop(1, "#9c6f1c");
  ctx.fillStyle = grd;
  ctx.beginPath();
  ctx.ellipse(0, 0, rx, r, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}
function drawVaultRain() {
  for (const c of rain) {
    ctx.globalAlpha = c.alpha;
    goldDisc(c.x, c.y, c.r, Math.cos(c.flip), c.rot);
  }
  ctx.globalAlpha = 1;
}

// A golden brick road receding to a glowing horizon, the register sitting on it.
function drawVault(g) {
  const horizonY = H * 0.4;
  const cx = W / 2;
  const roadHalfBottom = Math.min(W * 0.62, W / 2 - 10);
  const halfAt = (y) => roadHalfBottom * clamp((y - horizonY) / (H - horizonY), 0, 1);

  // sky → warm horizon
  const sky = ctx.createLinearGradient(0, 0, 0, horizonY);
  sky.addColorStop(0, "#0c0f1a");
  sky.addColorStop(0.6, "#3a2a10");
  sky.addColorStop(1, "#8a5e1c");
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W, horizonY);
  // dark ground either side of the road
  const gnd = ctx.createLinearGradient(0, horizonY, 0, H);
  gnd.addColorStop(0, "#33260b");
  gnd.addColorStop(1, "#0d0a04");
  ctx.fillStyle = gnd;
  ctx.fillRect(0, horizonY, W, H - horizonY);
  // sun glow at the vanishing point (warmer + a little brighter)
  const glow = ctx.createRadialGradient(cx, horizonY, 0, cx, horizonY, Math.min(W, H) * 0.6);
  glow.addColorStop(0, "rgba(255,224,140,0.7)");
  glow.addColorStop(0.45, "rgba(255,200,90,0.18)");
  glow.addColorStop(1, "rgba(255,196,86,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);

  // road surface (trapezoid to the vanishing point)
  ctx.beginPath();
  ctx.moveTo(cx - halfAt(H), H);
  ctx.lineTo(cx, horizonY);
  ctx.lineTo(cx + halfAt(H), H);
  ctx.closePath();
  const rg = ctx.createLinearGradient(0, horizonY, 0, H);
  rg.addColorStop(0, "#fff1c2");
  rg.addColorStop(0.5, "#e6b53e");
  rg.addColorStop(1, "#b9882a");
  ctx.fillStyle = rg;
  ctx.fill();

  // brick courses in perspective (clipped to the road)
  ctx.save();
  ctx.clip();
  let y = H;
  let gap = (H - horizonY) * 0.12; // denser courses
  let row = 0;
  const nb = 9;
  while (y > horizonY + 2) {
    const half = halfAt(y) || 0.0001;
    const ny = Math.max(horizonY, y - gap);
    const nhalf = halfAt(ny) || 0.0001;
    // alternate-course shading band for a bricky feel
    ctx.fillStyle = row % 2 ? "rgba(255,240,190,0.06)" : "rgba(120,84,14,0.07)";
    ctx.beginPath();
    ctx.moveTo(cx - half, y);
    ctx.lineTo(cx + half, y);
    ctx.lineTo(cx + nhalf, ny);
    ctx.lineTo(cx - nhalf, ny);
    ctx.closePath();
    ctx.fill();
    // horizontal mortar line
    ctx.strokeStyle = "rgba(110,76,12,0.6)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx - half, y);
    ctx.lineTo(cx + half, y);
    ctx.stroke();
    // vertical seams, offset every other course, converging toward the horizon
    const bw = (2 * half) / nb;
    const off = row % 2 ? bw / 2 : 0;
    for (let b = 0; b <= nb; b++) {
      const x = cx - half + off + b * bw;
      if (x <= cx - half || x >= cx + half) continue;
      const nx = cx + (x - cx) * (nhalf / half); // converge
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(nx, ny);
      ctx.stroke();
    }
    y -= gap;
    gap = Math.max(gap * 0.84, 3); // floor the gap so y always reaches the horizon (no infinite loop)
    row++;
  }
  ctx.restore();

  // glowing road edges
  ctx.strokeStyle = "rgba(255,247,205,0.6)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(cx - halfAt(H), H);
  ctx.lineTo(cx, horizonY);
  ctx.moveTo(cx + halfAt(H), H);
  ctx.lineTo(cx, horizonY);
  ctx.stroke();

  // gold brick walls rising from the road edges, framing the register
  drawBrickWalls(horizonY, cx, roadHalfBottom);

  // the register casts a warm pool of light onto the bricks beneath it
  if (g) {
    const lx = g.cx;
    const ly = g.by + g.bh * 0.98;
    const lr = g.bw * 0.95;
    const rgl = ctx.createRadialGradient(lx, ly, 0, lx, ly, lr);
    const warm = 0.28 + state.glow * 0.4; // brightens on a win
    rgl.addColorStop(0, `rgba(255,221,130,${warm})`);
    rgl.addColorStop(1, "rgba(255,221,130,0)");
    ctx.fillStyle = rgl;
    ctx.save();
    ctx.beginPath();
    ctx.ellipse(lx, ly, lr, lr * 0.42, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // gold bar stacks resting on the verge
  const by = H * 0.95;
  drawGoldBarStack(W * 0.1, by);
  drawGoldBarStack(W * 0.9, by);
}

// Two gold-brick walls standing on the road edges and receding to the vanishing
// point, turning the golden road into a vault corridor around the register. The
// geometry is a perspective trick: each wall is a triangle whose base is the road
// edge and whose apex is the horizon (height shrinks to 0 there). Because the
// foreshortening is linear in depth, brick courses and seams are straight lines.
function drawBrickWalls(horizonY, cx, roadHalfBottom) {
  const depth = H - horizonY;
  const wallH = depth * 0.6; // foreground wall height in px
  // t = 0 at the horizon, 1 at the foreground edge of the screen
  const baseX = (side, t) => cx + side * roadHalfBottom * t;
  const baseY = (t) => horizonY + t * depth;
  const topY = (t) => baseY(t) - wallH * t;

  for (const side of [-1, 1]) {
    const fx = baseX(side, 1); // front (foreground) inner edge x
    const fyB = baseY(1); // front base y (= H)
    const fyT = topY(1); // front top y

    ctx.save();
    // wall face: triangle from the horizon apex out to the front edge
    ctx.beginPath();
    ctx.moveTo(cx, horizonY);
    ctx.lineTo(fx, fyB);
    ctx.lineTo(fx, fyT);
    ctx.closePath();
    const wg = ctx.createLinearGradient(0, fyT, 0, fyB);
    wg.addColorStop(0, "#ffe9a8");
    wg.addColorStop(0.5, "#d9a93a");
    wg.addColorStop(1, "#8a5f1a");
    ctx.fillStyle = wg;
    ctx.fill();
    // shade so the vertical face reads darker than the bright floor; the left
    // wall catches a touch more of the central glow than the right
    ctx.fillStyle = side < 0 ? "rgba(0,0,0,0.10)" : "rgba(0,0,0,0.17)";
    ctx.fill();

    // clip bricks to the wall
    ctx.clip();
    // horizontal courses fanning from the horizon apex to the front edge
    ctx.strokeStyle = "rgba(90,60,10,0.55)";
    ctx.lineWidth = 1;
    const courses = 7;
    for (let k = 0; k <= courses; k++) {
      const f = k / courses;
      ctx.beginPath();
      ctx.moveTo(cx, horizonY);
      ctx.lineTo(fx, fyB - wallH * f);
      ctx.stroke();
    }
    // vertical seams (true verticals in screen space), bunching toward horizon,
    // offset every other depth band for a staggered bricky bond
    ctx.strokeStyle = "rgba(70,46,8,0.5)";
    const seams = [0.12, 0.2, 0.3, 0.42, 0.56, 0.72, 0.9];
    seams.forEach((t, i) => {
      const x = baseX(side, t);
      const yLo = baseY(t);
      const yHi = i % 2 ? topY(t) : topY(t) + wallH * t * 0.5; // alternate half/full seams
      ctx.beginPath();
      ctx.moveTo(x, yLo);
      ctx.lineTo(x, yHi);
      ctx.stroke();
    });
    // beveled highlight along the top edge for a 3D cap
    ctx.strokeStyle = "rgba(255,247,205,0.5)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx, horizonY);
    ctx.lineTo(fx, fyT);
    ctx.stroke();
    ctx.restore();
  }
}

function drawGoldBarStack(cx, baseY) {
  // a little pyramid of gold bars
  const bw = clamp(Math.min(W, H) * 0.07, 36, 90);
  const bh = bw * 0.42;
  const bar = (x, y) => {
    const g = ctx.createLinearGradient(x, y, x, y + bh);
    g.addColorStop(0, "#ffe9a8");
    g.addColorStop(0.5, "#e6b53e");
    g.addColorStop(1, "#a9801f");
    ctx.fillStyle = g;
    rr(x, y, bw, bh, bh * 0.18);
    ctx.fill();
    ctx.strokeStyle = "rgba(120,84,14,0.6)";
    ctx.lineWidth = 1;
    ctx.stroke();
    // top face sheen
    ctx.fillStyle = "rgba(255,255,255,0.18)";
    rr(x + bw * 0.1, y + bh * 0.12, bw * 0.8, bh * 0.22, bh * 0.1);
    ctx.fill();
  };
  const rows = [3, 2, 1];
  rows.forEach((nbar, r) => {
    const rowY = baseY - (r + 1) * (bh + 3);
    const rowX = cx - (nbar * (bw + 6)) / 2;
    for (let i = 0; i < nbar; i++) bar(rowX + i * (bw + 6) + (r * (bw + 6)) / 2, rowY);
  });
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
    if (d.profile) el.account.style.color = voiceFor(d.profile).color;
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
    if (t.profiles) renderProfiles(t.profiles);
  }
  if (d.day) state.day = d.day;
  if (d.leaderboard) state.boards.tokens = d.leaderboard;
  if (d.leaderboardCost) state.boards.cost = d.leaderboardCost;
  if (d.leaderboard || d.leaderboardCost) renderBoard();
}

function renderProfiles(list) {
  if (!list || !list.length) {
    el.profilesList.innerHTML = `<div class="empty">No spending yet.</div>`;
    return;
  }
  el.profilesList.innerHTML = list
    .map((p) => {
      const v = voiceFor(p.profile);
      const name = p.profile === "default" ? "default" : p.profile;
      return (
        `<div class="prow" style="--pc:${v.color}">` +
        `<div class="pname">${esc(name)}<span class="psub">${fmt(p.session.tokens)} tok this run</span></div>` +
        `<div class="pstat">today <b>${fmt(p.today.tokens)}</b> · ${usd(p.today.cost)}　all-time <b>${fmt(p.allTime.tokens)}</b> · ${usd(p.allTime.cost)}</div>` +
        `</div>`
      );
    })
    .join("");
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
      const v = voiceFor(e.profile);
      const chip = e.profile && e.profile !== "default" ? `<span class="pchip" style="background:${v.color}">${esc(e.profile)}</span>` : "";
      const label = e.label ? `<span class="label">${chip}${esc(e.label)}</span>` : `<span class="label dimlabel">${chip}— no prompt captured —</span>`;
      return `<li class="${flash.trim()}"><span class="toks">${primary}</span><span class="meta">${meta}</span>${label}</li>`;
    })
    .join("");
}

function fireBurst(d) {
  const tokens = Math.max(0, Math.round(d.turnTokens || 0));
  if (tokens <= 0) return;
  // Dormant: keep the board totals current, bank the spend for a catch-up
  // burst, but fire none of the animation/sound until the register is armed.
  if (!armed) {
    applyState(d);
    renderBoard(d.entryTs);
    pending.tokens += tokens;
    pending.cost += Number(d.cost) || 0;
    return;
  }
  stopAlert(d.profile); // this profile resumed → silence its "needs input" alarm
  const turnCost = Number(d.cost) || 0;
  const voice = voiceFor(d.profile);

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
  const profChip = d.profile && d.profile !== "default" ? `<span class="pchip" style="background:${voice.color}">${esc(d.profile)}</span> ` : "";
  const promptBit = d.promptLabel ? ` <span style="color:#cfe9da">“${esc(d.promptLabel)}”</span>` : "";
  el.lastEvent.innerHTML =
    `${profChip}<b>cha-ching!</b> +${fmt(tokens)} tokens · <b style="color:#ffe9a8">${usd(turnCost)}</b> on <b>${esc(d.model || state.model)}</b>` +
    promptBit +
    ` <span style="color:#8a93ad">(out ${fmt(u.output)} · cache+ ${fmt(u.cacheCreate)} · in ${fmt(u.input)} · cache-read ${fmt(u.cacheRead)})</span>` +
    (rank ? ` <span style="color:#ffcf3f">— #${rank} jackpot!</span>` : "");

  playChaChing(n, inten, d.profile);
  if (isTopRecord) playFanfare(d.profile);
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

  // vault rain — coins pouring from the ceiling, recycled at the bottom
  for (const c of rain) {
    c.y += c.vy * dt;
    c.x += c.vx * dt;
    c.rot += c.vrot * dt;
    c.flip += c.vflip * dt;
    if (c.y - c.r > H) resetRainCoin(c, true);
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

  drawVault(g); // golden brick road to a glowing horizon + gold-bar stacks
  drawVaultRain(); // coins raining from the sky (behind the register)
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
let muted = false; // mute button silences all synth sound; animation keeps playing
function initAudio() {
  if (audio) return;
  audio = new (window.AudioContext || window.webkitAudioContext)();
}
function setMuted(m) {
  muted = m;
  el.mute.textContent = m ? "🔇" : "🔊";
  el.mute.setAttribute("aria-pressed", String(m));
  el.mute.title = m ? "Unmute sounds" : "Mute sounds";
  try {
    localStorage.setItem("ccr-muted", m ? "1" : "0");
  } catch {}
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
function playChaChing(n, inten, profile) {
  if (!audio || muted) return;
  const m = voiceFor(profile).chMul; // per-profile pitch shift
  const t = audio.currentTime;
  // the "cha-ching" two-note bell
  tone(1318.5 * m, t, 0.18, "triangle", 0.25); // E6
  tone(1760.0 * m, t + 0.09, 0.32, "triangle", 0.28); // A6
  tone(880.0 * m, t + 0.09, 0.32, "sine", 0.12);
  // coin clinks spread across the fountain
  const clinks = Math.min(n, 36);
  const span = 0.5 + inten * 0.8;
  for (let i = 0; i < clinks; i++) {
    const tt = t + 0.05 + Math.random() * span;
    tone(rand(2200, 4200) * m, tt, 0.06, "square", 0.05);
  }
}
function playFanfare(profile) {
  if (!audio || muted) return;
  const m = voiceFor(profile).chMul;
  const t = audio.currentTime;
  // a rising major arpeggio for a brand-new record
  [523.25, 659.25, 783.99, 1046.5, 1318.5].forEach((f, i) => {
    tone(f * m, t + i * 0.1, 0.45, "triangle", 0.22);
  });
}
function playBuzzer(volScale = 1, profile) {
  if (!audio || muted) return;
  const v = voiceFor(profile);
  const peak = 0.45 * clamp(volScale, 0, 1); // escalating loudness
  const t = audio.currentTime;
  // three harsh buzzes — the "you're needed" klaxon, pitched per profile
  for (let k = 0; k < 3; k++) {
    const t0 = t + k * 0.32;
    const o = audio.createOscillator();
    const g = audio.createGain();
    const lfo = audio.createOscillator(); // amplitude wobble for a raspy buzz
    const lfoGain = audio.createGain();
    o.type = v.wave;
    o.frequency.value = v.buzz;
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
  if (!audio || muted) return;
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
  if (!armed) return; // dormant: roll the day silently, no popup/chime
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
// Each profile gets its OWN escalating alarm loop (distinct pitch), so work and
// personal can be needing input at the same time and you can tell which by ear.
// Each loops every 5s with rising volume until that profile's prompt is answered
// (UserPromptSubmit → alertstop), Claude resumes (a burst), a click/key, or a
// ~60s safety cap.
const ALERT_PERIOD_MS = 5000;
const ALERT_MAX_ITERS = 12; // ≈60s — never blare forever
const alarms = new Map(); // profile -> { interval, iteration, msg }

function renderSirenBanner() {
  const active = [...alarms.entries()];
  if (!active.length) return;
  el.sirenText.innerHTML = active
    .map(([p, a]) => `<span style="color:${voiceFor(p).color}">[${p}]</span> ${esc(a.msg)}`)
    .join("&nbsp;&nbsp;·&nbsp;&nbsp;");
}
function showSiren(d) {
  if (!armed) return; // dormant until enabled — no alarms
  const profile = d.profile || "default";
  const msg = (d.message || "Claude needs your input").toUpperCase();
  el.siren.classList.add("on");
  let a = alarms.get(profile);
  if (a) {
    a.msg = msg;
    renderSirenBanner();
    return; // already looping for this profile
  }
  a = { iteration: 0, interval: null, msg };
  alarms.set(profile, a);
  const step = () => {
    a.iteration++;
    const vol = Math.min(1, 0.4 + 0.15 * (a.iteration - 1)); // ramp 0.4 → 1
    playBuzzer(vol, profile);
    el.siren.style.setProperty("--siren-intensity", vol.toFixed(2));
    renderSirenBanner();
    if (a.iteration >= ALERT_MAX_ITERS) stopAlert(profile);
  };
  a.interval = setInterval(step, ALERT_PERIOD_MS);
  step();
}
function stopAlert(profile) {
  if (profile) {
    const a = alarms.get(profile);
    if (a) clearInterval(a.interval);
    alarms.delete(profile);
  } else {
    for (const a of alarms.values()) clearInterval(a.interval);
    alarms.clear();
  }
  if (alarms.size === 0) {
    el.siren.classList.remove("on");
    el.siren.style.setProperty("--siren-intensity", "0");
  } else {
    renderSirenBanner();
  }
}
// any click or key silences every alarm (you've seen it)
window.addEventListener("pointerdown", () => stopAlert());
window.addEventListener("keydown", () => stopAlert());

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
  es.addEventListener("alertstop", (e) => {
    let profile = "";
    try {
      profile = JSON.parse(e.data).profile || "";
    } catch {}
    stopAlert(profile || undefined); // answered → silence that profile (or all)
  });
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
// Bring the register to life: start reacting to events and replay one summary
// burst for whatever spend piled up while it was dormant.
function arm() {
  if (armed) return;
  armed = true;
  el.soundGate.classList.add("hidden");
  if (pending.tokens > 0) {
    fireBurst({
      turnTokens: pending.tokens,
      cost: pending.cost,
      model: state.model,
      promptLabel: "while you were away",
    });
    pending.tokens = 0;
    pending.cost = 0;
  }
}
el.enableSound.addEventListener("click", () => {
  initAudio(); // unmute, then arm
  arm();
});
el.tabTokens.addEventListener("click", () => setBoardView("tokens"));
el.tabCost.addEventListener("click", () => setBoardView("cost"));
// mute toggle — silence all sound but keep the show running. stopPropagation so
// the window pointerdown handler (which clears alerts) doesn't double-fire here.
el.mute.addEventListener("click", (e) => {
  e.stopPropagation();
  setMuted(!muted);
});
// explicit override: stop every buzzing alarm without waiting to answer Claude
el.clearAlert.addEventListener("click", (e) => {
  e.stopPropagation();
  stopAlert();
});
// allow muted viewing too: Escape arms the register without enabling sound
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") arm();
});

// URL conveniences: ?board=cost picks the cost leaderboard; ?nogate skips the
// click-to-enable-sound overlay and arms muted (handy for an always-on dashboard).
const params = new URLSearchParams(location.search);
if (params.get("board") === "cost") setBoardView("cost");
if (params.has("nogate")) arm();
// restore the saved mute preference (?muted also forces it on)
try {
  setMuted(localStorage.getItem("ccr-muted") === "1" || params.has("muted"));
} catch {
  setMuted(params.has("muted"));
}

resize();
requestAnimationFrame(frame);
connect();
