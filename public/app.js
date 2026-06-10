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
  leaderboard: document.getElementById("leaderboard"),
  profiles: document.getElementById("profiles"),
  profilesList: document.getElementById("profiles-list"),
  sparkPill: document.getElementById("spark-pill"),
  sparkline: document.getElementById("sparkline"),
  tabTokens: document.getElementById("tab-tokens"),
  tabCost: document.getElementById("tab-cost"),
  lastEvent: document.getElementById("last-event"),
  version: document.getElementById("version"),
  connDot: document.getElementById("conn-dot"),
  soundGate: document.getElementById("sound-gate"),
  enableSound: document.getElementById("enable-sound"),
  siren: document.getElementById("siren"),
  sirenText: document.getElementById("siren-text"),
  muteChaching: document.getElementById("mute-chaching"),
  muteBuzzer: document.getElementById("mute-buzzer"),
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
  seedWallSigns();
  seedMoneyFall();
}
window.addEventListener("resize", resize);

// ── world state ─────────────────────────────────────────────────────────────
const REEL_SYMBOLS = ["🍒", "🪙", "💵", "⭐", "💎", "7️⃣"];
const coins = [];
let sparks = [];
const dust = []; // ambient floating gold motes
const rain = []; // coins endlessly pouring from the vault ceiling (background)
const wallSigns = []; // green $ glyphs streaming down the brick walls into the sunset
const moneyFall = []; // 💰 bags, 💵 bills, and green $ signs drifting down the scene
const MONEY_KINDS = ["💰", "💵", "💴", "$", "$"]; // weighted a little toward $ signs

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
  todayCost: 0, // today's running $ spend, for the budget tint
  dailyBudget: 0, // 0 = no budget set; tints the today pill amber→red
  spark: [], // recent per-turn token counts, oldest→newest (sparkline)
  // animation
  shake: 0,
  glow: 0, // 0..1 register glow
  drawer: 0, // 0..1 till slide-out amount (0 shut, 1 fully ejected, can overshoot)
  drawerV: 0, // till spring velocity — kicked out on a burst, snaps shut after
  bell: 0, // 0..1 bell flash
  lever: 0, // -0.3..1 slot-lever pull; spring-yanked on every cha-ching
  leverV: 0, // lever spring velocity
  reels: [0, 0, 0].map(() => ({ symbol: 0, spinUntil: 0, offset: 0, speed: 0 })),
  spin: null, // current reel spin awaiting a triple-match check { evalAt, done, profile }
  jackpot: null, // active triple-match mega-dispense { until, profile }
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

// ── falling money (💰 bags, 💵 bills, green $ signs) tumbling down the scene ───
function resetMoneyItem(m, atTop) {
  const depth = Math.random(); // 0 far/small/slow → 1 near/big/fast (parallax)
  m.kind = MONEY_KINDS[(Math.random() * MONEY_KINDS.length) | 0];
  m.x = Math.random() * W;
  m.y = atTop ? rand(-70, -10) : Math.random() * H;
  m.size = 16 + depth * 30;
  m.vy = 0.6 + depth * 1.9;
  m.vx = rand(-0.3, 0.3);
  m.rot = rand(-0.4, 0.4);
  m.vrot = rand(-0.025, 0.025);
  m.sway = rand(0, Math.PI * 2);
  m.swaySpeed = rand(0.01, 0.03);
  m.alpha = 0.4 + depth * 0.5;
}
function seedMoneyFall() {
  moneyFall.length = 0;
  const count = clamp(Math.round(W / 60), 8, 40);
  for (let i = 0; i < count; i++) {
    const m = {};
    resetMoneyItem(m, false);
    moneyFall.push(m);
  }
}
function drawMoneyFall() {
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (const m of moneyFall) {
    ctx.globalAlpha = m.alpha;
    ctx.save();
    ctx.translate(m.x, m.y);
    ctx.rotate(m.rot);
    if (m.kind === "$") {
      // glowing green dollar sign with a gold edge
      ctx.font = `bold ${Math.round(m.size)}px Georgia, "Times New Roman", serif`;
      ctx.lineJoin = "round";
      ctx.lineWidth = Math.max(1.5, m.size * 0.12);
      ctx.strokeStyle = "#ffd35a";
      ctx.strokeText("$", 0, 0);
      ctx.fillStyle = "#2ecc71";
      ctx.fillText("$", 0, 0);
    } else {
      ctx.font = `${Math.round(m.size)}px serif`;
      ctx.fillText(m.kind, 0, 0);
    }
    ctx.restore();
  }
  ctx.globalAlpha = 1;
}

// A golden brick road receding to a glowing horizon, the register sitting on it.
function drawVault(g) {
  const horizonY = H * 0.4;
  const cx = W / 2;
  const roadHalfBottom = Math.min(W * 0.62, W / 2 - 10);
  const halfAt = (y) => roadHalfBottom * clamp((y - horizonY) / (H - horizonY), 0, 1);

  // sky → warm horizon, with a green undertone to cool the gold
  const sky = ctx.createLinearGradient(0, 0, 0, horizonY);
  sky.addColorStop(0, "#0c0f1a");
  sky.addColorStop(0.6, "#22300f");
  sky.addColorStop(1, "#6f7322");
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W, horizonY);
  // dark mossy-green ground either side of the road
  const gnd = ctx.createLinearGradient(0, horizonY, 0, H);
  gnd.addColorStop(0, "#1c3a1e");
  gnd.addColorStop(1, "#07120a");
  ctx.fillStyle = gnd;
  ctx.fillRect(0, horizonY, W, H - horizonY);
  // sun glow at the vanishing point (warmer + a little brighter)
  const glow = ctx.createRadialGradient(cx, horizonY, 0, cx, horizonY, Math.min(W, H) * 0.6);
  glow.addColorStop(0, "rgba(255,224,140,0.7)");
  glow.addColorStop(0.45, "rgba(255,200,90,0.18)");
  glow.addColorStop(1, "rgba(255,196,86,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);
  // giant sunset aura blooming behind the register
  drawSunsetAura();
  // giant green dollar signs standing along the horizon
  drawHorizonSigns();

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
  // gold-bordered green dollar emblems mounted down the walls toward the sunset
  drawWallSigns();

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

// Shared wall geometry (mirrors the perspective trick in drawBrickWalls): the two
// gold-brick walls stand on the road edges and recede to the vanishing point at
// (cx, horizonY). t = 1 is the foreground edge of the screen, t → 0 the horizon.
function wallGeom() {
  const horizonY = H * 0.4;
  const cx = W / 2;
  const roadHalfBottom = Math.min(W * 0.62, W / 2 - 10);
  const depth = H - horizonY;
  const wallH = depth * 0.6;
  return { horizonY, cx, roadHalfBottom, depth, wallH };
}

// A fixed grid of large dollar-sign emblems mounted on each wall, marching in
// perspective down toward the vanishing point so they converge into the sunset.
// They don't move — each is pinned at a depth band (t) and a height up the wall
// (v), with a little jitter so the grid doesn't read as mechanical.
function seedWallSigns() {
  wallSigns.length = 0;
  const depths = [0.26, 0.42, 0.6, 0.82]; // near-horizon → foreground
  const heights = [0.34, 0.64, 0.92]; // low / mid / high on the wall face
  for (const side of [-1, 1]) {
    for (const t of depths) {
      for (const v of heights) {
        wallSigns.push({
          side, // -1 left wall, +1 right wall
          t: clamp(t + rand(-0.025, 0.025), 0.1, 0.9),
          v: clamp(v + rand(-0.05, 0.05), 0.12, 1),
        });
      }
    }
  }
}
// One green, gold-bordered, double-struck "$" centered at (x,y).
function drawWallDollar(x, y, size, fill = "#0c5e2c", border = "#ffd35a") {
  ctx.save();
  ctx.translate(x, y);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  ctx.font = `900 ${Math.round(size)}px Georgia, "Times New Roman", serif`;
  // dark halo so the gold border reads even against the gold brick wall
  ctx.lineWidth = Math.max(3, size * 0.24);
  ctx.strokeStyle = "rgba(0,0,0,0.5)";
  ctx.strokeText("S", 0, 0);
  // gold border
  ctx.lineWidth = Math.max(2, size * 0.14);
  ctx.strokeStyle = border;
  ctx.strokeText("S", 0, 0);
  // green body
  ctx.fillStyle = fill;
  ctx.fillText("S", 0, 0);
  // the two vertical strikes (the "double" dollar bars), gold-edged green
  const barW = size * 0.11;
  const barH = size * 0.96;
  const off = size * 0.15;
  for (const bx of [-off, off]) {
    rr(bx - barW / 2, -barH / 2, barW, barH, barW * 0.4);
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.lineWidth = Math.max(1.5, size * 0.05);
    ctx.strokeStyle = border;
    ctx.stroke();
  }
  ctx.restore();
}

// A row of giant green dollar signs standing along the horizon, glowing behind
// the register and flanking the sunset.
function drawHorizonSigns() {
  const { horizonY, cx } = wallGeom();
  const size = clamp(Math.min(W, H) * 0.16, 64, 190);
  const gap = size * 1.9;
  const count = Math.ceil(W / gap) + 2;
  const startX = cx - ((count - 1) / 2) * gap;
  const y = horizonY - size * 0.28; // straddle the horizon, tops in the sky
  // green glow halo behind each sign
  for (let i = 0; i < count; i++) {
    const x = startX + i * gap;
    const gg = ctx.createRadialGradient(x, y, 0, x, y, size);
    gg.addColorStop(0, "rgba(46,204,113,0.42)");
    gg.addColorStop(1, "rgba(46,204,113,0)");
    ctx.fillStyle = gg;
    ctx.fillRect(x - size, y - size, size * 2, size * 2);
  }
  // the giant signs themselves — brighter green than the wall emblems
  for (let i = 0; i < count; i++) {
    drawWallDollar(startX + i * gap, y, size, "#1faa55", "#ffe08a");
  }
}
function drawWallSigns() {
  const { horizonY, cx, roadHalfBottom, depth, wallH } = wallGeom();
  for (const sgn of wallSigns) {
    const t = sgn.t;
    const baseX = cx + sgn.side * roadHalfBottom * t; // road edge at this depth
    const baseY = horizonY + t * depth;
    const topY = baseY - wallH * t;
    const x = baseX;
    const y = baseY + (topY - baseY) * sgn.v; // v=0 base, v=1 top
    const size = clamp(70 * t, 16, 78); // large, shrinking with depth
    ctx.globalAlpha = clamp(0.6 + t * 0.4, 0, 1);
    drawWallDollar(x, y, size);
  }
  ctx.globalAlpha = 1;
}

// Giant sunset aura blooming from the vanishing point, directly behind the
// register — concentric warm bands from a white-gold core out to dusk purple.
function drawSunsetAura() {
  const { horizonY, cx } = wallGeom();
  const cy = horizonY + H * 0.04; // sit just under the horizon, behind the body

  // ── radiating gold sun rays, slowly wheeling and pulsing (drawn first) ──
  const t = performance.now() / 1000;
  ctx.save();
  ctx.globalCompositeOperation = "lighter"; // additive, so overlaps blaze brighter
  const rayCount = 20;
  const rayLen = Math.max(W, H) * (0.9 + state.glow * 0.2);
  const baseRayGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, rayLen);
  baseRayGrad.addColorStop(0, "rgba(255,240,176,1)");
  baseRayGrad.addColorStop(0.5, "rgba(255,205,90,0.45)");
  baseRayGrad.addColorStop(1, "rgba(255,196,86,0)");
  for (let i = 0; i < rayCount; i++) {
    const a = (i / rayCount) * Math.PI * 2 + t * 0.05; // slow wheel
    const pulse = 0.5 + 0.5 * Math.sin(t * 0.9 + i * 1.7); // each beam breathes
    const halfW = (0.018 + 0.016 * pulse) * Math.PI; // angular half-width
    const alpha = (0.05 + 0.07 * pulse) * (0.75 + state.glow * 0.6);
    ctx.globalAlpha = alpha;
    ctx.fillStyle = baseRayGrad;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, rayLen, a - halfW, a + halfW);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();

  // ── soft concentric sunset bloom over the rays: brighter, warmer core ──
  const R = Math.max(W, H) * (0.64 + state.glow * 0.1); // swells a touch on a win
  const grd = ctx.createRadialGradient(cx, cy, 0, cx, cy, R);
  grd.addColorStop(0.0, "rgba(255,251,228,0.99)"); // blazing white-gold core
  grd.addColorStop(0.1, "rgba(255,233,150,0.82)"); // bright gold
  grd.addColorStop(0.26, "rgba(255,206,104,0.5)"); // gold
  grd.addColorStop(0.42, "rgba(168,210,102,0.38)"); // green-gold
  grd.addColorStop(0.6, "rgba(56,168,104,0.26)"); // emerald
  grd.addColorStop(0.8, "rgba(30,96,80,0.13)"); // jade dusk
  grd.addColorStop(1.0, "rgba(16,44,40,0)");
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, W, H);
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
    if (t.today) {
      state.todayCost = Number(t.today.cost) || 0;
      el.today.textContent = `today: ${fmt(t.today.tokens)} tok · ${usd(t.today.cost)}`;
      applyBudgetTint();
    }
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
  refreshScrollFades();
}

// Toggle each panel's `.can-scroll-down` class so its bottom fade + ▾ chevron
// (style.css) only appears while there are more rows below the fold. Run on
// scroll, resize, and after every re-render. rAF-deferred so the DOM has laid
// out the freshly-rendered list before we measure it.
function refreshScrollFades() {
  requestAnimationFrame(() => {
    for (const [panel, list] of [
      [el.leaderboard, el.board],
      [el.profiles, el.profilesList],
    ]) {
      if (!panel || !list) continue;
      const more = list.scrollHeight - list.scrollTop - list.clientHeight > 4;
      panel.classList.toggle("can-scroll-down", more);
    }
  });
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
    refreshScrollFades();
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
  refreshScrollFades();
}

// ── daily budget tint (#today pill) ──────────────────────────────────────────
// A click on the today pill sets a soft daily $ target stored in localStorage;
// the pill stays gold under ~75% of it, warms to amber, then blazes red over.
function applyBudgetTint() {
  const b = state.dailyBudget;
  el.today.classList.remove("budget-warn", "budget-over");
  if (b > 0) {
    const frac = state.todayCost / b;
    if (frac >= 1) el.today.classList.add("budget-over");
    else if (frac >= 0.75) el.today.classList.add("budget-warn");
    el.today.title = `Daily budget ${usd(b)} — ${usd(state.todayCost)} spent (${Math.round(frac * 100)}%). Click to change.`;
  } else {
    el.today.title = "Click to set a daily budget";
  }
}
function setDailyBudget(v) {
  state.dailyBudget = Number(v) > 0 ? Number(v) : 0;
  try {
    if (state.dailyBudget > 0) localStorage.setItem("ccr-daily-budget", String(state.dailyBudget));
    else localStorage.removeItem("ccr-daily-budget");
  } catch {}
  applyBudgetTint();
}
function promptDailyBudget() {
  const cur = state.dailyBudget > 0 ? String(state.dailyBudget) : "";
  const ans = window.prompt("Daily spend budget in dollars (blank to clear):", cur);
  if (ans === null) return; // cancelled
  const n = parseFloat(ans.replace(/[^0-9.]/g, ""));
  setDailyBudget(Number.isFinite(n) ? n : 0);
}

// ── sparkline: recent per-turn token counts in a tiny HUD canvas ─────────────
const SPARK_MAX = 30;
function pushSpark(tokens) {
  state.spark.push(Math.max(0, tokens));
  if (state.spark.length > SPARK_MAX) state.spark.shift();
  drawSparkline();
}
function drawSparkline() {
  const cv = el.sparkline;
  if (!cv) return;
  const data = state.spark;
  if (data.length < 2) {
    el.sparkPill.classList.add("empty"); // nothing meaningful to show yet
    return;
  }
  el.sparkPill.classList.remove("empty");
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const cw = cv.clientWidth || 72;
  const ch = cv.clientHeight || 18;
  if (cv.width !== Math.round(cw * dpr)) {
    cv.width = Math.round(cw * dpr);
    cv.height = Math.round(ch * dpr);
  }
  const c = cv.getContext("2d");
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, cw, ch);
  const max = Math.max(...data, 1);
  const pad = 2;
  const x = (i) => pad + (i / (data.length - 1)) * (cw - pad * 2);
  const y = (v) => ch - pad - (v / max) * (ch - pad * 2);
  // soft gold area fill under the line
  c.beginPath();
  c.moveTo(x(0), ch);
  data.forEach((v, i) => c.lineTo(x(i), y(v)));
  c.lineTo(x(data.length - 1), ch);
  c.closePath();
  c.fillStyle = "rgba(255,207,63,0.18)";
  c.fill();
  // the trend line
  c.beginPath();
  data.forEach((v, i) => (i ? c.lineTo(x(i), y(v)) : c.moveTo(x(i), y(v))));
  c.strokeStyle = "#ffcf3f";
  c.lineWidth = 1.5;
  c.lineJoin = "round";
  c.stroke();
  // dot on the latest point
  c.beginPath();
  c.arc(x(data.length - 1), y(data[data.length - 1]), 1.8, 0, Math.PI * 2);
  c.fillStyle = "#ffe9a8";
  c.fill();
}

// Shared till geometry (drawDrawer + dispenseCoins agree on it): the drawer
// slides down+out from the register body by `state.drawer` (0 shut → 1 ejected).
function drawerGeom(g) {
  const { bx, by, bw, bh, s } = g;
  const open = clamp(state.drawer, 0, 1.12);
  const dw = bw * 0.86;
  const dh = 34 * s;
  const x = bx + (bw - dw) / 2;
  const restY = by + bh - 30 * s; // closed: front face tucked under the body
  const faceY = restY + open * 56 * s; // front face top edge, slid out
  const backY = restY + 2 * s; // hinge line where the open tray meets the body
  return { open, dw, dh, x, restY, faceY, backY, s, cx: g.cx };
}
// Where coins erupt from: the open till's front lip.
function drawerMouth(g) {
  const d = drawerGeom(g);
  return { x: d.cx, y: d.faceY + 2 * d.s, halfW: d.dw * 0.4 };
}

// Spit coins out of the open till's front lip. `powMul` scales launch power,
// `spread` widens the fan. Shared by the normal burst and the jackpot torrent.
function dispenseCoins(g, count, powMul, spread) {
  const m = drawerMouth(g);
  const mouthX = m.x;
  const mouthY = m.y;
  for (let i = 0; i < count; i++) {
    const ang = -Math.PI / 2 + rand(-0.9, 0.9) * spread;
    const power = rand(5, 11) * powMul;
    coins.push({
      x: mouthX + rand(-m.halfW, m.halfW),
      y: mouthY + rand(-4, 4) * g.s,
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
  if (coins.length > 1500) coins.splice(0, coins.length - 1500);
}

// All three reels lined up → an insane payout: a sustained coin torrent (see the
// emitter in step()), max shake/glow, a fresh lever yank, and a triumphant sound.
function triggerJackpot(now, profile) {
  state.jackpot = { until: now + 2800, profile };
  state.shake = Math.max(state.shake, 36);
  state.glow = 1;
  state.bell = 1;
  state.drawerV = Math.max(state.drawerV, 0.9); // slam the till out hard
  state.lever = 1; // yank again as the coins explode
  state.leverV = 0;
  const g = geom();
  spawnDustBurst(g, 1);
  dispenseCoins(g, 220, 1.7, 1.25); // opening blast; the emitter keeps it pouring
  state.popup = {
    text: "💎💰 JACKPOT — TRIPLE MATCH! 💰💎",
    life: 1.9,
    color: "#ffe25a",
  };
  playJackpotSound(profile);
}

function fireBurst(d) {
  const tokens = Math.max(0, Math.round(d.turnTokens || 0));
  if (tokens <= 0) return;
  pushSpark(tokens); // track turn size for the HUD sparkline (even while dormant)
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
  state.drawerV = Math.max(state.drawerV, 0.5 + inten * 0.4); // kick the till out, harder on big turns
  state.bell = 1;

  // cha-ching yanks the slot lever (see step()'s lever spring + drawLever)
  state.lever = 1;
  state.leverV = 0;

  // reels spin; a top-tier jackpot lands on a matched triple. Lower turns get
  // random symbols — but if they happen to line up, the triple-match payout
  // (evaluated in step() when the reels settle) still fires.
  const now = performance.now();
  const jackpot = tier >= 4;
  const matched = Math.floor(rand(3, REEL_SYMBOLS.length)); // a "good" symbol
  let lastSpinEnd = now;
  state.reels.forEach((r, i) => {
    r.spinUntil = now + 650 + inten * 1400 + i * 220;
    r.speed = 0.6 + inten * 0.9;
    r.target = jackpot ? matched : Math.floor(rand(0, REEL_SYMBOLS.length));
    lastSpinEnd = Math.max(lastSpinEnd, r.spinUntil);
  });
  state.spin = { evalAt: lastSpinEnd + 30, done: false, profile: d.profile };

  // coin fountain
  const g = geom();
  dispenseCoins(g, n, 0.8 + inten, 1);

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
  // till spring: a burst kicks state.drawerV positive (see fireBurst); the till
  // springs toward "out" (1) while coins are still flying, then snaps shut once
  // they drain, overshooting slightly into a ka-chunk bounce against the body.
  const drawerTarget = coins.length > 0 ? 1 : 0;
  state.drawerV += (drawerTarget - state.drawer) * 0.14 * dt;
  state.drawerV *= Math.pow(0.78, dt);
  state.drawer += state.drawerV * dt;
  if (state.drawer < 0) {
    // hit the closed stop — bounce back a touch for the ka-chunk
    state.drawer = 0;
    state.drawerV = Math.max(0, -state.drawerV * 0.25);
  }
  state.drawer = Math.min(state.drawer, 1.12);

  // lever spring: a cha-ching sets state.lever=1 (fully pulled); it springs back
  // toward rest with a little recoil overshoot so the red knob visibly snaps.
  state.leverV += -state.lever * 0.12 * dt;
  state.leverV *= Math.pow(0.82, dt);
  state.lever += state.leverV * dt;
  if (state.lever < -0.3) {
    state.lever = -0.3;
    state.leverV = 0;
  }
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

  // falling money — bags, bills & $ signs tumbling and swaying down the scene
  for (const m of moneyFall) {
    m.y += m.vy * dt;
    m.sway += m.swaySpeed * dt;
    m.x += (m.vx + Math.sin(m.sway) * 0.4) * dt;
    m.rot += m.vrot * dt;
    if (m.y - m.size > H + 20) resetMoneyItem(m, true);
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

  // once all reels have settled, check for a triple match → jackpot payout
  if (state.spin && !state.spin.done && now >= state.spin.evalAt) {
    state.spin.done = true;
    const [a, b, c] = state.reels;
    if (a.symbol === b.symbol && b.symbol === c.symbol) {
      triggerJackpot(now, state.spin.profile);
    }
  }

  // jackpot torrent — keep dumping coins (and a little dust) until it expires
  if (state.jackpot) {
    if (now >= state.jackpot.until) {
      state.jackpot = null;
    } else if (coins.length < 1400) {
      dispenseCoins(geom(), 16, 1.7, 1.25);
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
  drawMoneyFall(); // 💰 bags, 💵 bills & green $ tumbling down (behind the register)
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

// The cash till: a brass drawer that slides out toward the viewer on a burst,
// its open top face revealing coin cups + bill bays brimming with money, the
// front panel riding lowest (closest to us). All driven by `state.drawer`.
function drawDrawer(g) {
  const d = drawerGeom(g);
  const { open, dw, dh, x, faceY, backY, s, cx } = d;
  const fy = faceY;

  // ── open till tray (perspective top face) — only while it's pulled out ──
  if (open > 0.04) {
    const inset = 16 * s; // the opening narrows toward the back (perspective)
    const lerp = (a, b, t) => a + (b - a) * t;
    const trayPt = (u, v) => {
      const left = lerp(x + inset, x, v);
      const right = lerp(x + dw - inset, x + dw, v);
      return [lerp(left, right, u), lerp(backY, fy, v)];
    };
    const reveal = clamp(open * 1.3, 0, 1); // contents fade in as it opens
    const p0 = trayPt(0, 0),
      p1 = trayPt(1, 0),
      p2 = trayPt(1, 1),
      p3 = trayPt(0, 1);
    const trayPath = () => {
      ctx.beginPath();
      ctx.moveTo(p0[0], p0[1]);
      ctx.lineTo(p1[0], p1[1]);
      ctx.lineTo(p2[0], p2[1]);
      ctx.lineTo(p3[0], p3[1]);
      ctx.closePath();
    };

    ctx.save();
    // green felt floor of the till
    trayPath();
    const fg = ctx.createLinearGradient(0, backY, 0, fy);
    fg.addColorStop(0, "#0a3526");
    fg.addColorStop(1, "#11543c");
    ctx.fillStyle = fg;
    ctx.fill();
    ctx.clip(); // keep cups, bills and glow inside the tray

    // warm cavity glow welling up from inside the register
    const gg = ctx.createLinearGradient(0, backY, 0, fy);
    gg.addColorStop(0, `rgba(255,210,110,${0.4 * reveal})`);
    gg.addColorStop(1, "rgba(255,210,110,0)");
    ctx.fillStyle = gg;
    ctx.fillRect(x, backY, dw, fy - backY);

    // coin cups (back row): dark wells each cradling a gold coin
    for (let i = 0; i < 5; i++) {
      const [ccx, ccy] = trayPt(0.13 + i * 0.185, 0.3);
      const rw = dw * 0.07,
        rh = rw * 0.5;
      ctx.fillStyle = "rgba(0,0,0,0.32)";
      ctx.beginPath();
      ctx.ellipse(ccx, ccy, rw, rh, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = `rgba(255,206,80,${0.92 * reveal})`;
      ctx.beginPath();
      ctx.ellipse(ccx, ccy - rh * 0.3, rw * 0.72, rh * 0.72, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = `rgba(255,243,196,${0.7 * reveal})`;
      ctx.beginPath();
      ctx.ellipse(ccx - rw * 0.2, ccy - rh * 0.5, rw * 0.26, rh * 0.26, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    // bill bays (front): longitudinal slots with green banknotes peeking out
    const quad = (a, b, c, e) => {
      ctx.beginPath();
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(b[0], b[1]);
      ctx.lineTo(c[0], c[1]);
      ctx.lineTo(e[0], e[1]);
      ctx.closePath();
    };
    for (let i = 0; i < 4; i++) {
      const uL = 0.08 + i * 0.225,
        uR = uL + 0.17;
      quad(trayPt(uL, 0.52), trayPt(uR, 0.52), trayPt(uR, 0.95), trayPt(uL, 0.95));
      ctx.fillStyle = "rgba(0,0,0,0.22)";
      ctx.fill();
      quad(trayPt(uL + 0.02, 0.6), trayPt(uR - 0.02, 0.6), trayPt(uR - 0.02, 0.88), trayPt(uL + 0.02, 0.88));
      ctx.fillStyle = `rgba(60,150,96,${0.88 * reveal})`;
      ctx.fill();
      ctx.strokeStyle = `rgba(185,255,212,${0.5 * reveal})`;
      ctx.lineWidth = 1 * s;
      ctx.stroke();
    }
    ctx.restore();

    // brass rim framing the open mouth
    trayPath();
    ctx.strokeStyle = brassStroke();
    ctx.lineWidth = 2 * s;
    ctx.stroke();
  }

  // ── drawer front panel (rides lowest, closest to the viewer) ──
  ctx.fillStyle = brassFill(x, fy, fy + dh);
  rr(x, fy, dw, dh, 6 * s);
  ctx.fill();
  ctx.strokeStyle = brassStroke();
  ctx.lineWidth = 2 * s;
  ctx.stroke();
  const ig = ctx.createLinearGradient(x, fy, x, fy + dh);
  ig.addColorStop(0, "#14543f");
  ig.addColorStop(1, "#0c3325");
  ctx.fillStyle = ig;
  rr(x + 8 * s, fy + 6 * s, dw - 16 * s, dh - 12 * s, 4 * s);
  ctx.fill();
  // handle
  ctx.fillStyle = "#ffe9a8";
  rr(x + dw / 2 - 24 * s, fy + dh / 2 - 3 * s, 48 * s, 6 * s, 3 * s);
  ctx.fill();
}

function drawLever(g, now) {
  const { bx, by, bh, s } = g;
  const baseX = bx - 6 * s;
  const baseY = by + bh * 0.4;
  const spinning = state.reels.some((r) => now < r.spinUntil);
  // the cha-ching spring (state.lever) drives the yank; while the reels are still
  // spinning the lever rests half-pulled. clamp keeps the recoil from over-rising.
  const pull = clamp(Math.max(state.lever, spinning ? 0.5 : 0), -0.3, 1);
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
// Two independent mutes — either can be silenced on its own while the animation
// keeps playing. cha-ching covers the win sounds (cha-ching / fanfare / day
// chime); buzzer covers the "Claude needs your input" klaxon.
let muteChaching = false;
let muteBuzzer = false;
function initAudio() {
  if (audio) return;
  audio = new (window.AudioContext || window.webkitAudioContext)();
}
function setMuteChaching(m) {
  muteChaching = m;
  el.muteChaching.textContent = m ? "🔇 💰" : "🔊 💰";
  el.muteChaching.setAttribute("aria-pressed", String(m));
  el.muteChaching.title = m ? "Unmute cha-ching" : "Mute cha-ching";
  try {
    localStorage.setItem("ccr-mute-chaching", m ? "1" : "0");
  } catch {}
}
function setMuteBuzzer(m) {
  muteBuzzer = m;
  el.muteBuzzer.textContent = m ? "🔇 🚨" : "🔊 🚨";
  el.muteBuzzer.setAttribute("aria-pressed", String(m));
  el.muteBuzzer.title = m ? "Unmute buzzer" : "Mute buzzer";
  try {
    localStorage.setItem("ccr-mute-buzzer", m ? "1" : "0");
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
  if (!audio || muteChaching) return;
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
  if (!audio || muteChaching) return;
  const m = voiceFor(profile).chMul;
  const t = audio.currentTime;
  // a rising major arpeggio for a brand-new record
  [523.25, 659.25, 783.99, 1046.5, 1318.5].forEach((f, i) => {
    tone(f * m, t + i * 0.1, 0.45, "triangle", 0.22);
  });
}
function playJackpotSound(profile) {
  if (!audio || muteChaching) return;
  const m = voiceFor(profile).chMul;
  const t = audio.currentTime;
  // a big triumphant rising run, doubled an octave down for heft
  const run = [523.25, 659.25, 783.99, 1046.5, 1318.5, 1567.98, 2093.0];
  run.forEach((f, i) => {
    tone(f * m, t + i * 0.08, 0.5, "triangle", 0.24);
    tone(f * m * 0.5, t + i * 0.08, 0.5, "sine", 0.08);
  });
  // a couple of bright bell dings on top
  tone(1760.0 * m, t + 0.5, 0.45, "triangle", 0.2);
  tone(2349.3 * m, t + 0.64, 0.55, "triangle", 0.2);
  // a long cascade of coin clinks raining for the duration of the torrent
  for (let i = 0; i < 90; i++) {
    const tt = t + 0.1 + Math.random() * 2.5;
    tone(rand(2200, 4600) * m, tt, 0.05, "square", 0.045);
  }
}
function playBuzzer(volScale = 1, profile) {
  if (!audio || muteBuzzer) return;
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
  if (!audio || muteChaching) return;
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
  state.todayCost = 0;
  applyBudgetTint();
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
      const data = JSON.parse(e.data);
      if (data.version) el.version.textContent = ` · v${data.version}`;
      applyState(data);
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
// independent mute toggles — silence cha-ching or the buzzer on its own while the
// show keeps running. stopPropagation so the window pointerdown handler (which
// clears alerts) doesn't double-fire here.
el.muteChaching.addEventListener("click", (e) => {
  e.stopPropagation();
  setMuteChaching(!muteChaching);
});
el.muteBuzzer.addEventListener("click", (e) => {
  e.stopPropagation();
  setMuteBuzzer(!muteBuzzer);
});
// explicit override: stop every buzzing alarm without waiting to answer Claude
el.clearAlert.addEventListener("click", (e) => {
  e.stopPropagation();
  stopAlert();
});
// click the today pill to set/clear a daily spend budget
el.today.addEventListener("click", (e) => {
  e.stopPropagation();
  promptDailyBudget();
});
// keep the scroll fades + sparkline correct when a panel scrolls or the window
// resizes (the panels' max-height is viewport-relative, so what's "below the
// fold" changes with height).
el.board.addEventListener("scroll", refreshScrollFades, { passive: true });
el.profilesList.addEventListener("scroll", refreshScrollFades, { passive: true });
window.addEventListener("resize", () => {
  refreshScrollFades();
  drawSparkline();
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
// restore saved mute prefs. ?muted forces both on; ?mute=chaching|buzzer targets
// just one. The legacy single key (ccr-muted) migrates to muting both.
const muteParam = params.get("mute"); // "chaching" | "buzzer"
let legacyMuted = false;
let savedCha = null;
let savedBuz = null;
try {
  legacyMuted = localStorage.getItem("ccr-muted") === "1";
  savedCha = localStorage.getItem("ccr-mute-chaching");
  savedBuz = localStorage.getItem("ccr-mute-buzzer");
} catch {}
const forceBoth = params.has("muted");
setMuteChaching((savedCha != null ? savedCha === "1" : legacyMuted) || forceBoth || muteParam === "chaching");
setMuteBuzzer((savedBuz != null ? savedBuz === "1" : legacyMuted) || forceBoth || muteParam === "buzzer");

// daily budget: ?budget=20 overrides (and persists) the saved value.
let savedBudget = 0;
try {
  savedBudget = parseFloat(localStorage.getItem("ccr-daily-budget")) || 0;
} catch {}
const budgetParam = parseFloat(params.get("budget"));
if (Number.isFinite(budgetParam)) setDailyBudget(budgetParam);
else setDailyBudget(savedBudget);

resize();
drawSparkline(); // hidden until ≥2 turns have landed
requestAnimationFrame(frame);
connect();
