/* global Plotly */

const DATA_BASE = "./data";

const PULSE_SPEED = 0.65;
const UPPER_MULT  = 1.00;

const LABEL_COLOR = {
  NORMAL: "#94a3b8",
  YELLOW: "#facc15",
  ORANGE: "#fb923c",
  RED: "#ef4444",
};

const $ = (sel) => document.querySelector(sel);

const ONDEMAND_ENDPOINT = "https://yt-ondemand.araki-69c.workers.dev/ondemand";

const POLL_INTERVAL_MS = 3000;
const POLL_TRIES_INDEX = 60;
const POLL_TRIES_DATA  = 60;

const state = {
  index: null,
  currentChannelId: null,
  mode: "views_days",
  yLog: false,
  inputMode: "select",
  channelCache: new Map(),

  redPlotPoints: [],
  pulseRunning: false,
  pulseT: 0,
  plotEventsAttached: false,

  activeChannelItem: null,
};

function safeNum(v, dflt = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}
function fmtInt(n) {
  n = safeNum(n, 0);
  return n.toLocaleString("en-US");
}
function youtubeUrl(videoId) {
  return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId || "")}`;
}
async function fetchJson(path) {
  const r = await fetch(path, { cache: "no-store" });
  if (!r.ok) throw new Error(`fetch failed: ${path} (${r.status})`);
  return await r.json();
}
async function fetchMaybeOk(path) {
  const r = await fetch(path, { cache: "no-store" });
  return r.ok;
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function getChannelId(ch) { return ch?.channel_id || ch?.channelId || ch?.id || ""; }
function getChannelTitle(ch) { return ch?.title || ch?.handle || ch?.watch_key || ch?.watchKey || getChannelId(ch) || "(unknown)"; }
function getStickyCount(ch) { return safeNum(ch?.sticky_red_count, safeNum(ch?.sticky_red, safeNum(ch?.sticky, 0))); }
function getWorstAnomaly(ch) { return safeNum(ch?.max_anomaly_ratio, safeNum(ch?.worst_anomaly, safeNum(ch?.worst, NaN))); }

function normalizePoints(pointsJson) {
  if (Array.isArray(pointsJson)) return pointsJson;
  if (pointsJson && Array.isArray(pointsJson.points)) return pointsJson.points;
  if (pointsJson && Array.isArray(pointsJson.items)) return pointsJson.items;
  return [];
}

/* ★新形式優先（video_id / views / likes / days）＋旧形式フォールバック */
function getVideoId(p) { return p?.video_id || p?.videoId || p?.id || ""; }
function getTitle(p) { return p?.title || "(no title)"; }
function getDays(p) { return safeNum(p?.days, safeNum(p?.t_days, NaN)); }
function getViews(p) { return safeNum(p?.views, safeNum(p?.viewCount, NaN)); }
function getLikes(p) { return safeNum(p?.likes, safeNum(p?.likeCount, NaN)); }
function getAnomalyRatio(p) { return safeNum(p?.anomaly_ratio, NaN); }
function getRatioNat(p) { return safeNum(p?.ratio_nat, NaN); }
function getRatioLike(p) { return safeNum(p?.ratio_like, NaN); }

/* ★ショート判定（run_weekly.py の isShort を最優先） */
function isShortPoint(p) {
  if (p?.isShort === true) return true;
  const dur = Number(p?.durationSec);
  if (Number.isFinite(dur) && dur > 0 && dur <= 60) return true;
  return false;
}

/* 上限線判定（ln/exp前提） */
function upperViewsForDays(days, baseline) {
  const a = safeNum(baseline?.a_days, NaN);
  const b = safeNum(baseline?.b_days, NaN);
  const NAT_UP = safeNum(baseline?.NAT_UPPER_RATIO, NaN) * UPPER_MULT;
  if (!(Number.isFinite(a) && Number.isFinite(b) && Number.isFinite(NAT_UP))) return NaN;

  const d = Math.max(1, safeNum(days, NaN));
  if (!Number.isFinite(d)) return NaN;

  const log_center = a + b * d;
  const log_upper = log_center + Math.log(NAT_UP);
  return Math.exp(log_upper);
}

function upperViewsForLikes(likes, baseline) {
  const b0 = safeNum(baseline?.b0, NaN);
  const b1 = safeNum(baseline?.b1, NaN);
  const NAT_UP = safeNum(baseline?.NAT_UPPER_RATIO, NaN) * UPPER_MULT;
  if (!(Number.isFinite(b0) && Number.isFinite(b1) && Number.isFinite(NAT_UP))) return NaN;

  const L = safeNum(likes, NaN);
  if (!(Number.isFinite(L) && L > 0)) return NaN;

  const logV = b0 + b1 * Math.log(L);
  const V_expected = Math.exp(logV);
  return V_expected * NAT_UP;
}

function classifyByUpper(p, baseline) {
  const v = getViews(p);
  const d = getDays(p);
  const l = getLikes(p);
  const ar = getAnomalyRatio(p);

  const upV_days  = upperViewsForDays(d, baseline);
  const upV_likes = upperViewsForLikes(l, baseline);

  const exDays  = Number.isFinite(upV_days)  ? (v > upV_days)  : false;
  const exLikes = Number.isFinite(upV_likes) ? (v > upV_likes) : false;

  if (exDays && exLikes) return "RED";
  if (exDays || exLikes) {
    if (Number.isFinite(ar) && ar >= 10.0) return "ORANGE";
    return "YELLOW";
  }
  return "NORMAL";
}

/* 実力値表示 */
function renderPowerInfo(bundle) {
  const el = $("#powerInfo");
  if (!el) return;

  const b = bundle?.latest?.baseline || {};
  const a = safeNum(b?.a_days, NaN);
  const bb = safeNum(b?.b_days, NaN);

  if (!(Number.isFinite(a) && Number.isFinite(bb))) {
    el.textContent = "";
    return;
  }

  const v1 = Math.exp(a + bb * 1.0);
  if (!Number.isFinite(v1)) {
    el.textContent = "";
    return;
  }

  el.textContent = `表示中の実力値（初日期待値）: ${fmtInt(Math.round(v1))}`;
}

function setInputMode(mode) {
  state.inputMode = mode;
  $("#btnInputSelect")?.classList.toggle("active", mode === "select");
  $("#btnInputManual")?.classList.toggle("active", mode === "manual");
  $("#selectBox")?.classList.toggle("hidden", mode !== "select");
  $("#manualBox")?.classList.toggle("hidden", mode !== "manual");
}
function showManualHint(msg) {
  const el = $("#manualHint");
  if (el) el.textContent = msg || "";
}
function normalizeManual(raw) { return String(raw || "").trim(); }

function findChannelIdByManualInput(raw) {
  const s = normalizeManual(raw);
  if (!s) return null;
  if (s.startsWith("UC")) return s;

  const key = s.toLowerCase();
  const arr = Array.isArray(state.index?.channels) ? state.index.channels : [];
  const hit = arr.find(ch => {
    const a = String(ch?.watch_key || ch?.watchKey || "").toLowerCase();
    const b = String(ch?.handle || "").toLowerCase();
    const c = String(ch?.title || "").toLowerCase();
    return a === key || b === key || c.includes(key);
  });
  return hit ? getChannelId(hit) : null;
}

/* ★ondemandレスポンスがJSONじゃない/空のときに黙らない */
async function startOndemand(rawInput) {
  const payload = { channel: normalizeManual(rawInput) };
  const r = await fetch(ONDEMAND_ENDPOINT, {
    method: "POST",
    mode: "cors",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const text = await r.text().catch(() => "");
  if (!r.ok) throw new Error(`ondemand http ${r.status}: ${text}`);

  try {
    const j = JSON.parse(text);
    return j && typeof j === "object" ? j : {};
  } catch (e) {
    // ここで理由が見えるようにする
    throw new Error(`ondemand response is not JSON: ${text.slice(0, 400)}`);
  }
}

async function refreshIndex() {
  const index = await fetchJson(`${DATA_BASE}/index.json`);
  state.index = index;
  renderChannelList(index);
  renderChannelSelect(index);
  return index;
}

/* ★進捗(i/60)を出す */
async function waitChannelIdFromIndex(rawInput) {
  const input = normalizeManual(rawInput);
  const lower = input.toLowerCase();

  for (let i = 0; i < POLL_TRIES_INDEX; i++) {
    showManualHint(`解析中…（index更新待ち ${i + 1}/${POLL_TRIES_INDEX}）`);

    const idx = await refreshIndex().catch(() => null);
    const arr = Array.isArray(idx?.channels) ? idx.channels : [];

    const id1 = findChannelIdByManualInput(input);
    if (id1) return id1;

    const key2 = lower.startsWith("@") ? lower.slice(1) : lower;
    const hit = arr.find(ch => {
      const h = String(ch?.handle || "").toLowerCase().replace(/^@/, "");
      const t = String(ch?.title || "").toLowerCase();
      return h === key2 || t.includes(key2);
    });
    if (hit) return getChannelId(hit);

    await sleep(POLL_INTERVAL_MS);
  }
  return null;
}

async function waitChannelDataReady(channelId) {
  const base = `${DATA_BASE}/channels/${channelId}`;
  const probe = `${base}/latest_points.json`;
  for (let i = 0; i < POLL_TRIES_DATA; i++) {
    showManualHint(`解析中…（データ生成待ち ${i + 1}/${POLL_TRIES_DATA}）`);
    const ok = await fetchMaybeOk(probe);
    if (ok) return true;
    await sleep(POLL_INTERVAL_MS);
  }
  return false;
}

function setActiveChannelItem(el) {
  if (state.activeChannelItem) state.activeChannelItem.classList.remove("active");
  state.activeChannelItem = el;
  if (state.activeChannelItem) state.activeChannelItem.classList.add("active");
}

function renderChannelList(index) {
  const root = $("#channelList");
  if (!root) return;
  root.innerHTML = "";

  const arr0 = Array.isArray(index?.channels) ? index.channels : [];
  const arr = arr0.filter(ch => getStickyCount(ch) > 0).slice();

  arr.sort((a,b) => {
    const wa = getWorstAnomaly(a);
    const wb = getWorstAnomaly(b);
    const aa = Number.isFinite(wa) ? wa : -Infinity;
    const bb = Number.isFinite(wb) ? wb : -Infinity;
    return bb - aa;
  });

  if (!arr.length) {
    root.innerHTML = `<div class="item"><div class="m">対象なし（sticky_red_count > 0 のみ表示）</div></div>`;
    return;
  }

  arr.slice(0, 80).forEach((ch) => {
    const div = document.createElement("div");
    div.className = "item";

    const id = getChannelId(ch);
    const title = getChannelTitle(ch);
    const worst = getWorstAnomaly(ch);
    const sticky = getStickyCount(ch);

    div.innerHTML = `
      <div class="t">${escapeHtml(title)}</div>
      <div class="m">worst: ${Number.isFinite(worst) ? worst.toFixed(2) : "?"} / sticky_red: ${sticky}</div>
    `;

    div.addEventListener("click", () => {
      if (!id) return;
      setActiveChannelItem(div);
      setChannel(id).catch(console.error);
    });

    if (id && id === state.currentChannelId) setActiveChannelItem(div);
    root.appendChild(div);
  });
}

function renderChannelSelect(index) {
  const sel = $("#channelSelect");
  if (!sel) return;
  sel.innerHTML = "";
  const arr = Array.isArray(index?.channels) ? index.channels : [];

  arr.forEach((ch) => {
    const opt = document.createElement("option");
    opt.value = getChannelId(ch);
    opt.textContent = `${getChannelTitle(ch)} (sticky_red=${getStickyCount(ch)})`;
    sel.appendChild(opt);
  });

  sel.addEventListener("change", () => {
    const id = sel.value;
    if (id) setChannel(id).catch(console.error);
  });
}

function updateYScaleButtons() {
  const btnLog = $("#btnYLog");
  const btnLin = $("#btnYLin");
  if (!btnLog || !btnLin) return;
  const enabled = (state.mode === "views_days");
  btnLog.disabled = !enabled;
  btnLin.disabled = !enabled;
  btnLog.classList.toggle("active", enabled && state.yLog);
  btnLin.classList.toggle("active", enabled && !state.yLog);
}

function setMode(mode) {
  state.mode = mode;
  $("#btnViewsDays")?.classList.toggle("active", mode === "views_days");
  $("#btnViewsLikes")?.classList.toggle("active", mode === "views_likes");
  updateYScaleButtons();
  if (state.currentChannelId) {
    const cached = state.channelCache.get(state.currentChannelId);
    if (cached) drawPlot(cached).catch(console.error);
  }
}

function setYLog(on) {
  state.yLog = !!on;
  updateYScaleButtons();
  if (state.mode !== "views_days") return;
  if (state.currentChannelId) {
    const cached = state.channelCache.get(state.currentChannelId);
    if (cached) drawPlot(cached).catch(console.error);
  }
}

async function loadChannelBundle(channelId) {
  if (state.channelCache.has(channelId)) return state.channelCache.get(channelId);

  const base = `${DATA_BASE}/channels/${channelId}`;
  const [channel, latest, pointsJson, st] = await Promise.all([
    fetchJson(`${base}/channel.json`).catch(() => ({})),
    fetchJson(`${base}/latest.json`).catch(() => ({})),
    fetchJson(`${base}/latest_points.json`).catch(() => ({})),
    fetchJson(`${base}/state.json`).catch(() => ({})),
  ]);

  const points = normalizePoints(pointsJson);
  const bundle = { channel, latest, points, state: st };
  state.channelCache.set(channelId, bundle);
  return bundle;
}

async function setChannel(channelId) {
  state.currentChannelId = channelId;
  const sel = $("#channelSelect");
  if (sel) sel.value = channelId;

  const bundle = await loadChannelBundle(channelId);
  renderPowerInfo(bundle);
  renderBaselineInfo(bundle);
  await drawPlot(bundle);
  renderRedList(bundle);

  if (state.index) renderChannelList(state.index);
}

function renderBaselineInfo(bundle) {
  const b = bundle?.latest?.baseline || {};
  const title = bundle?.channel?.title || state.currentChannelId || "(unknown)";
  const a = safeNum(b?.a_days, NaN);
  const bb = safeNum(b?.b_days, NaN);
  const b0 = safeNum(b?.b0, NaN);
  const b1 = safeNum(b?.b1, NaN);
  const up = safeNum(b?.NAT_UPPER_RATIO, NaN);
  $("#baselineInfo").textContent =
    `Channel: ${title}` +
    ` / nat: ln(V)=a+b*days (a=${Number.isFinite(a)?a.toFixed(3):"?"}, b=${Number.isFinite(bb)?bb.toExponential(2):"?"})` +
    ` / like: ln(V)=b0+b1*ln(L) (b0=${Number.isFinite(b0)?b0.toFixed(3):"?"}, b1=${Number.isFinite(b1)?b1.toFixed(3):"?"})` +
    ` / upper=${Number.isFinite(up)?up.toFixed(2):"?"}*${UPPER_MULT.toFixed(2)}` +
    ` / pulse=${PULSE_SPEED.toFixed(2)}`;
}

/* baseline lines */
function linspace(xmin, xmax, n) {
  if (n <= 1) return [xmin];
  const arr = [];
  const step = (xmax - xmin) / (n - 1);
  for (let i = 0; i < n; i++) arr.push(xmin + step * i);
  return arr;
}

function buildBaselineTraces(mode, rows, baseline) {
  if (!rows.length) return [];
  const N = 400;

  if (mode === "views_days") {
    const a = safeNum(baseline?.a_days, NaN);
    const b = safeNum(baseline?.b_days, NaN);
    const NAT_UP = safeNum(baseline?.NAT_UPPER_RATIO, NaN) * UPPER_MULT;
    if (!(Number.isFinite(a) && Number.isFinite(b) && Number.isFinite(NAT_UP))) return [];

    const daysArr = rows.map(getDays).filter(v => Number.isFinite(v));
    const tmax = Math.max(...daysArr, 1);
    const t_line = linspace(1, tmax, N);

    const log_center = t_line.map(t => a + b * t);
    const log_upper  = log_center.map(lv => lv + Math.log(NAT_UP));

    const v_center = log_center.map(lv => Math.exp(lv));
    const v_upper  = log_upper.map(lv => Math.exp(lv));

    return [
      { type:"scatter", mode:"lines", name:"expected", x:t_line, y:v_center, hoverinfo:"skip", line:{ width:2, dash:"solid" } },
      { type:"scatter", mode:"lines", name:"upper",    x:t_line, y:v_upper,  hoverinfo:"skip", line:{ width:2, dash:"dot" } },
    ];
  }

  const b0 = safeNum(baseline?.b0, NaN);
  const b1 = safeNum(baseline?.b1, NaN);
  const NAT_UP = safeNum(baseline?.NAT_UPPER_RATIO, NaN) * UPPER_MULT;
  if (!(Number.isFinite(b0) && Number.isFinite(b1))) return [];

  const likesArr = rows.map(getLikes).filter(v => v > 0);
  if (!likesArr.length) return [];
  const lmin = Math.min(...likesArr);
  const lmax = Math.max(...likesArr);

  const logL_line = linspace(Math.log(lmin), Math.log(lmax), 300);
  const logV_line = logL_line.map(x => b0 + b1 * x);

  const views_line = logV_line.map(lv => Math.exp(lv));
  const likes_line = logL_line.map(ll => Math.exp(ll));

  const traces = [
    { type:"scatter", mode:"lines", name:"expected", x:views_line, y:likes_line, hoverinfo:"skip", line:{ width:2, dash:"solid" } },
  ];

  if (Number.isFinite(NAT_UP)) {
    traces.push({
      type:"scatter", mode:"lines", name:"upper",
      x: views_line.map(v => v * NAT_UP), y: likes_line,
      hoverinfo:"skip", line:{ width:2, dash:"dot" }
    });
  }
  return traces;
}

function computeRedPlotPoints(rows, mode, baseline) {
  const red = [];
  for (const p of rows) {
    const label = classifyByUpper(p, baseline);
    if (label !== "RED") continue;

    const v = getViews(p);
    const l = getLikes(p);
    const d = getDays(p);

    let x, y;
    if (mode === "views_days") { x = d; y = v; } else { x = v; y = l; }
    if (!(x >= 0 && y > 0)) continue;

    const ar = getAnomalyRatio(p);
    const strength = Math.max(0.15, Math.min(1.0, Math.log10((Number.isFinite(ar) ? ar : 0) + 1) / 2.0));
    red.push({ x, y, strength });
  }
  return red;
}

function syncPulseCanvasToPlot() {
  const gd = $("#plot");
  const c  = $("#plotPulse");
  if (!gd || !c || !gd._fullLayout) return;

  const fl = gd._fullLayout;
  const sz = fl._size;
  if (!sz) return;

  c.style.left = `${sz.l}px`;
  c.style.top  = `${sz.t}px`;
  c.style.width  = `${sz.w}px`;
  c.style.height = `${sz.h}px`;
  c.style.position = "absolute";

  const dpr = window.devicePixelRatio || 1;
  c.width  = Math.max(1, Math.floor(sz.w * dpr));
  c.height = Math.max(1, Math.floor(sz.h * dpr));
}

function dataToPixel(gd, x, y) {
  const fl = gd._fullLayout;
  if (!fl) return null;
  const xa = fl.xaxis;
  const ya = fl.yaxis;
  const sz = fl._size;
  if (!xa || !ya || !sz) return null;

  let px = xa.c2p(x);
  let py = ya.c2p(y);

  if (px > sz.w + sz.l) px -= sz.l;
  if (py > sz.h + sz.t) py -= sz.t;

  return { px, py };
}

function drawPulses() {
  const gd = $("#plot");
  const c  = $("#plotPulse");
  if (!gd || !c) return;
  const ctx = c.getContext("2d");
  if (!ctx) return;

  const dpr = window.devicePixelRatio || 1;
  const w = c.width;
  const h = c.height;

  ctx.clearRect(0, 0, w, h);

  const t = state.pulseT;
  const pts = state.redPlotPoints;
  if (!pts || pts.length === 0) return;

  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const xy = dataToPixel(gd, p.x, p.y);
    if (!xy) continue;

    const x = xy.px * dpr;
    const y = xy.py * dpr;
    if (!(x >= -50 && x <= w + 50 && y >= -50 && y <= h + 50)) continue;

    const phase = (i * 17) % 97;
    const beat = 0.5 + 0.5 * Math.sin((t * 0.22 * PULSE_SPEED) + phase) * Math.sin((t * 0.07 * PULSE_SPEED) + phase * 0.3);

    const alpha = (0.10 + 0.28 * p.strength) * beat;
    const baseR = (8 + 14 * p.strength) * dpr;
    const gap   = (7 + 10 * p.strength) * dpr;

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = "rgba(255, 80, 80, 1)";
    ctx.lineWidth = Math.max(1, Math.floor(2 * dpr));
    for (let k = 0; k < 3; k++) {
      const rr = baseR + k * gap;
      ctx.beginPath();
      ctx.arc(x, y, rr, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }
}

function pulseLoop() {
  if (!state.pulseRunning) return;
  state.pulseT += 1;
  drawPulses();
  requestAnimationFrame(pulseLoop);
}
function ensurePulseLoop() {
  if (state.pulseRunning) return;
  state.pulseRunning = true;
  state.pulseT = 0;
  requestAnimationFrame(pulseLoop);
}

function attachPlotEventsOnce() {
  if (state.plotEventsAttached) return;
  state.plotEventsAttached = true;

  const gd = $("#plot");
  if (!gd) return;

  gd.on("plotly_afterplot", () => syncPulseCanvasToPlot());
  gd.on("plotly_relayout", () => syncPulseCanvasToPlot());
  window.addEventListener("resize", () => syncPulseCanvasToPlot());
}

/* ---------- plot ---------- */
async function drawPlot(bundle) {
  const points = Array.isArray(bundle?.points) ? bundle.points : [];
  const baseline = bundle?.latest?.baseline || {};

  /* ★ショートは両モード共通で完全除外（判定も表示もしない） */
  const rows = points.filter(p => {
    if (isShortPoint(p)) return false;

    const v = getViews(p);
    const l = getLikes(p);
    const d = getDays(p);

    if (state.mode === "views_days") {
      // ★likesは要求しない（ここを壊すと全件落ちる）
      return Number.isFinite(v) && v > 0 && Number.isFinite(d) && d >= 1;
    }

    if (state.mode === "views_likes") {
      return (Number.isFinite(v) && v > 0 && Number.isFinite(l) && l > 0);
    }

    return false;
  });

  const xs = [];
  const ys = [];
  const hover = [];
  const colors = [];
  const sizes = [];

  for (const p of rows) {
    const id = getVideoId(p);
    const title = getTitle(p);
    const d = getDays(p);
    const v = getViews(p);
    const l = getLikes(p);

    const rn = getRatioNat(p);
    const rl = getRatioLike(p);
    const ar = getAnomalyRatio(p);

    let x, y;
    if (state.mode === "views_days") { x = d; y = v; } else { x = v; y = l; }

    const label = classifyByUpper(p, baseline);

    xs.push(x);
    ys.push(y);
    colors.push(LABEL_COLOR[label] || LABEL_COLOR.NORMAL);
    sizes.push(label === "RED" ? 9 : (label === "ORANGE" ? 8 : (label === "YELLOW" ? 8 : 6)));

    hover.push([
      `<b>${escapeHtml(title)}</b>`,
      `判定: <b>${escapeHtml(label)}</b>`,
      `days: ${Number.isFinite(d) ? d.toFixed(2) : "?"}`,
      `views: ${Number.isFinite(v) ? fmtInt(v) : "?"}`,
      `likes: ${Number.isFinite(l) ? fmtInt(l) : "?"}`,
      `ratio_nat: ${Number.isFinite(rn) ? rn.toFixed(2) : "?"}`,
      `ratio_like: ${Number.isFinite(rl) ? rl.toFixed(2) : "NA"}`,
      `anomaly_ratio: ${Number.isFinite(ar) ? ar.toFixed(2) : "?"}`,
      `<a href="${youtubeUrl(id)}" target="_blank" rel="noreferrer">open</a>`,
    ].join("<br>"));
  }

  const scatter = {
    type: "scattergl",
    mode: "markers",
    name: "videos",
    x: xs,
    y: ys,
    text: hover,
    hoverinfo: "text",
    marker: { size: sizes, opacity: 0.9, color: colors },
  };

  const lines = buildBaselineTraces(state.mode, rows, baseline);

  const layout = {
    margin: { l: 60, r: 20, t: 40, b: 60 },
    paper_bgcolor: "rgba(0,0,0,0)",
    plot_bgcolor: "rgba(0,0,0,0)",
    showlegend: true,
    legend: { orientation: "h", x: 0, y: 1.1 },
  };

  if (state.mode === "views_days") {
    layout.title = { text: "再生数乖離評価（ショート除外）", x: 0.02 };
    layout.xaxis = { title: "days since publish", type: "linear", gridcolor: "rgba(255,255,255,0.06)" };
    layout.yaxis = { title: "views", type: state.yLog ? "log" : "linear", gridcolor: "rgba(255,255,255,0.06)" };
  } else {
    layout.title = { text: "高評価乖離評価（ショート除外）", x: 0.02 };
    layout.xaxis = { title: "views", type: "log", gridcolor: "rgba(255,255,255,0.06)" };
    layout.yaxis = { title: "likes", type: "log", gridcolor: "rgba(255,255,255,0.06)" };
  }

  await Plotly.newPlot("plot", [scatter, ...lines], layout, { displayModeBar:true, responsive:true });

  state.redPlotPoints = computeRedPlotPoints(rows, state.mode, baseline);
  syncPulseCanvasToPlot();
  ensurePulseLoop();
  attachPlotEventsOnce();

  updateYScaleButtons();
  renderBaselineInfo(bundle);
}

/* RED list */
function normalizeRedTop(st) {
  const raw = Array.isArray(st?.red_top) ? st.red_top : Array.isArray(st?.redTop) ? st.redTop : [];
  return raw.map((it) => (typeof it === "string" ? { video_id: it } : it)).filter(Boolean);
}

function renderRedList(bundle) {
  const root = $("#redList");
  if (!root) return;
  root.innerHTML = "";

  const st = bundle?.state || {};
  const redTop = normalizeRedTop(st);
  const points = Array.isArray(bundle?.points) ? bundle.points : [];

  const lookup = new Map();
  for (const p of points) {
    const id = getVideoId(p);
    if (id) lookup.set(id, p);
  }

  /* ★右ペインもショート完全除外 */
  const list = redTop
    .slice(0, 80)
    .map((x) => {
      const id = getVideoId(x) || x.video_id || x.id || "";
      return lookup.get(id) || x;
    })
    .filter((p) => !isShortPoint(p))
    .slice(0, 30);

  if (!list.length) {
    root.innerHTML = `<div class="item"><div class="m">異常値が上位の動画がありません（ショート除外）</div></div>`;
    return;
  }

  for (const p of list) {
    const id = getVideoId(p) || p.video_id || "";
    const title = getTitle(p);
    const ar = getAnomalyRatio(p);
    const v = getViews(p);
    const l = getLikes(p);

    const div = document.createElement("div");
    div.className = "item";
    div.innerHTML = `
      <div class="t"><a href="${youtubeUrl(id)}" target="_blank" rel="noreferrer">${escapeHtml(title)}</a></div>
      <div class="m">anomaly_ratio: ${Number.isFinite(ar) ? ar.toFixed(2) : "?"} / views: ${Number.isFinite(v) ? fmtInt(v) : "?"} / likes: ${Number.isFinite(l) ? fmtInt(l) : "?"}</div>
    `;
    root.appendChild(div);
  }
}

async function boot() {
  $("#btnViewsDays")?.addEventListener("click", () => setMode("views_days"));
  $("#btnViewsLikes")?.addEventListener("click", () => setMode("views_likes"));
  $("#btnYLog")?.addEventListener("click", () => setYLog(true));
  $("#btnYLin")?.addEventListener("click", () => setYLog(false));

  $("#btnInputSelect")?.addEventListener("click", () => setInputMode("select"));
  $("#btnInputManual")?.addEventListener("click", () => setInputMode("manual"));

  $("#btnLoadInput")?.addEventListener("click", async () => {
    const btn = $("#btnLoadInput");
    const raw = $("#channelInput")?.value || "";
    const input = normalizeManual(raw);
    if (!input) { showManualHint("入力してください。"); return; }

    try {
      if (btn) btn.disabled = true;

      const already = findChannelIdByManualInput(input);
      if (already) { showManualHint(""); await setChannel(already); return; }

      showManualHint("解析中…（オンデマンド起動中）");
      const res = await startOndemand(input);

      let channelId =
        (res && (res.channel_id || res.channelId || res.id)) ||
        (input.startsWith("UC") ? input : null);

      // JSONが返ってきてるなら、ここで少なくとも何か見える
      if (!channelId) {
        showManualHint("解析中…（index更新待ち）");
        channelId = await waitChannelIdFromIndex(input);
      }

      if (!channelId) {
        showManualHint("失敗: index にチャンネルが反映されませんでした（ondemand側で弾かれた/同期失敗の可能性）");
        return;
      }

      const ok = await waitChannelDataReady(channelId);
      if (!ok) {
        showManualHint("失敗: data/channels/<id>/latest_points.json が反映されませんでした");
        return;
      }

      await refreshIndex().catch(() => {});
      showManualHint("");
      await setChannel(channelId);
      setInputMode("select");
    } catch (e) {
      console.error(e);
      showManualHint(`失敗: ${e?.message || e}`);
    } finally {
      if (btn) btn.disabled = false;
    }
  });

  updateYScaleButtons();
  setInputMode("select");

  const index = await fetchJson(`${DATA_BASE}/index.json`);
  state.index = index;
  renderChannelList(index);
  renderChannelSelect(index);

  const first = Array.isArray(index?.channels) ? index.channels[0] : null;
  const channelId = getChannelId(first);
  if (channelId) await setChannel(channelId);
}

boot().catch((e) => {
  console.error(e);
  const el = $("#baselineInfo");
  if (el) el.textContent = `boot error: ${e?.message || e}`;
});
