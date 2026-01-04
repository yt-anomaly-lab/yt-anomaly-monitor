/* global Plotly */

const DATA_BASE = "./data";

/* ===== 調整パラメータ（あなたの要望） ===== */
const PULSE_SPEED = 0.65;     // ドクドク速度（小さいほど遅い）
const UPPER_MULT  = 1.00;     // 上限倍率に掛ける追加係数（データ側 * これ）

const LABEL_COLOR = {
  NORMAL: "#3b82f6",
  YELLOW: "#facc15",
  ORANGE: "#fb923c",
  RED: "#ef4444",
};

const $ = (sel) => document.querySelector(sel);

/* Cloudflare Workers（yt-ondemand） */
const ONDEMAND_ENDPOINT = "https://yt-ondemand.araki-69c.workers.dev/ondemand";

/* ポーリング設定（Pages反映待ち） */
const POLL_INTERVAL_MS = 3000;
const POLL_TRIES_INDEX = 60;   // index.json 待ち（最大 ~3分）
const POLL_TRIES_DATA  = 60;   // channel data 待ち（最大 ~3分）

const state = {
  index: null,
  currentChannelId: null,
  mode: "views_days",
  yLog: true,
  inputMode: "select",
  channelCache: new Map(),

  redPlotPoints: [],
  pulseRunning: false,
  pulseT: 0,
  plotEventsAttached: false,
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
function pick(obj, keys) {
  for (const k of keys) if (obj && obj[k] != null) return obj[k];
  return undefined;
}

/* ---------- index.json 互換 ---------- */
function getChannelId(ch) { return ch?.channel_id || ch?.channelId || ch?.id || ""; }
function getChannelTitle(ch) { return ch?.title || ch?.handle || ch?.watch_key || ch?.watchKey || getChannelId(ch) || "(unknown)"; }
function getStickyCount(ch) { return safeNum(ch?.sticky_red_count, safeNum(ch?.sticky_red, safeNum(ch?.sticky, 0))); }
function getWorstAnomaly(ch) { return safeNum(ch?.max_anomaly_ratio, safeNum(ch?.worst_anomaly, safeNum(ch?.worst, NaN))); }

/* ---------- latest_points.json（run_weekly 形式） ---------- */
function normalizePoints(pointsJson) {
  if (Array.isArray(pointsJson)) return pointsJson;
  if (pointsJson && Array.isArray(pointsJson.points)) return pointsJson.points;
  if (pointsJson && Array.isArray(pointsJson.items)) return pointsJson.items;
  return [];
}
function getVideoId(p) { return p?.videoId || p?.video_id || p?.id || ""; }
function getTitle(p) { return p?.title || "(no title)"; }
function getDays(p) { return safeNum(p?.t_days, safeNum(p?.days, NaN)); } // t_days を優先（make_plots）
function getViews(p) { return safeNum(p?.viewCount, safeNum(p?.views, NaN)); }
function getLikes(p) { return safeNum(p?.likeCount, safeNum(p?.likes, NaN)); }
function getLabel(p) { return String(pick(p, ["display_label", "observed_label", "label"]) ?? "NORMAL").toUpperCase(); }
function getAnomalyRatio(p) { return safeNum(p?.anomaly_ratio, NaN); }
function getRatioNat(p) { return safeNum(p?.ratio_nat, NaN); }
function getRatioLike(p) { return safeNum(p?.ratio_like, NaN); }

/* ---------- 入力モード（既存UIを維持） ---------- */
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

function normalizeManual(raw) {
  return String(raw || "").trim();
}

/* 既知のindex内から手入力を解決（UC / @handle / watch_key / title 部分一致） */
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

/* ---------- オンデマンド実行 ---------- */
async function startOndemand(rawInput) {
  const payload = { channel: normalizeManual(rawInput) };

  // 診断ログ
  console.log("[ondemand] endpoint:", ONDEMAND_ENDPOINT);
  console.log("[ondemand] payload:", payload);

  try {
    // まずは到達性チェック（GETでCORS許可がないとここで落ちる）
    // ※ WorkerがGETを許可しないならコメントアウトでOK
    // await fetch(ONDEMAND_ENDPOINT, { method: "GET", cache: "no-store" });

    const r = await fetch(ONDEMAND_ENDPOINT, {
      method: "POST",
      mode: "cors",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    console.log("[ondemand] status:", r.status);
    const text = await r.text().catch(() => "");
    console.log("[ondemand] body:", text);

    if (!r.ok) throw new Error(`ondemand http ${r.status}: ${text}`);

    try { return JSON.parse(text); }
    catch { return {}; }
  } catch (e) {
    // ここに来ると「ネットワーク層」エラー（CORS/到達性/ブロック）
    console.error("[ondemand] fetch error:", e);
    throw e;
  }
}

async function refreshIndex() {
  const index = await fetchJson(`${DATA_BASE}/index.json`);
  state.index = index;
  renderChannelList(index);
  renderChannelSelect(index);
  return index;
}

/* index.json に入力が現れるのを待つ（@handle の場合に必要） */
async function waitChannelIdFromIndex(rawInput) {
  const input = normalizeManual(rawInput);
  const lower = input.toLowerCase();

  for (let i = 0; i < POLL_TRIES_INDEX; i++) {
    const idx = await refreshIndex().catch(() => null);
    const arr = Array.isArray(idx?.channels) ? idx.channels : [];

    // 1) 直接一致できるならそれを使う
    const id1 = findChannelIdByManualInput(input);
    if (id1) return id1;

    // 2) それでも無理なら、handleの「@なし一致」も拾う
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

/* channelの生成物（latest_points.json）が来るまで待つ */
async function waitChannelDataReady(channelId) {
  const base = `${DATA_BASE}/channels/${channelId}`;
  const probe = `${base}/latest_points.json`;

  for (let i = 0; i < POLL_TRIES_DATA; i++) {
    const ok = await fetchMaybeOk(probe);
    if (ok) return true;
    await sleep(POLL_INTERVAL_MS);
  }
  return false;
}

/* ---------- UI ---------- */
function renderChannelList(index) {
  const root = $("#channelList");
  if (!root) return;
  root.innerHTML = "";
  const arr = Array.isArray(index?.channels) ? index.channels : [];
  arr.slice(0, 60).forEach((ch) => {
    const div = document.createElement("div");
    div.className = "item";
    const title = getChannelTitle(ch);
    const worst = getWorstAnomaly(ch);
    const sticky = getStickyCount(ch);
    div.innerHTML = `
      <div class="t">${escapeHtml(title)}</div>
      <div class="m">worst: ${Number.isFinite(worst) ? worst.toFixed(2) : "?"} / sticky_red: ${sticky}</div>
    `;
    div.addEventListener("click", () => {
      const id = getChannelId(ch);
      if (id) setChannel(id);
    });
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
    if (id) setChannel(id);
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
    if (cached) drawPlot(cached);
  }
}

function setYLog(on) {
  state.yLog = !!on;
  updateYScaleButtons();
  if (state.mode !== "views_days") return;
  if (state.currentChannelId) {
    const cached = state.channelCache.get(state.currentChannelId);
    if (cached) drawPlot(cached);
  }
}

/* ---------- load ---------- */
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
  renderBaselineInfo(bundle);
  await drawPlot(bundle);
  renderRedList(bundle);
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

/* ---------- baseline lines（make_plots 完全一致） ---------- */
function linspace(xmin, xmax, n) {
  if (n <= 1) return [xmin];
  const arr = [];
  const step = (xmax - xmin) / (n - 1);
  for (let i = 0; i < n; i++) arr.push(xmin + step * i);
  return arr;
}
function logspace(xmin, xmax, n) {
  const lo = Math.log10(xmin);
  const hi = Math.log10(xmax);
  const arr = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    arr.push(Math.pow(lo + (hi - lo) * t));
  }
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

    const log_center = t_line.map(t => a + b * t);                 // ln(V)
    const log_upper  = log_center.map(lv => lv + Math.log(NAT_UP)); // lnで +ln

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

  const logL_line = linspace(Math.log(lmin), Math.log(lmax), 300); // ln(L)
  const logV_line = logL_line.map(x => b0 + b1 * x);               // ln(V)

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

/* ---------- pulse overlay（現状維持） ---------- */
function computeRedPlotPoints(rows, mode) {
  const red = [];
  for (const p of rows) {
    const label = getLabel(p);
    const isRed = (label === "RED") || (p?.sticky_red === true);
    if (!isRed) continue;

    const v = getViews(p);
    const l = getLikes(p);
    const d = getDays(p);

    let x, y;
    if (mode === "views_days") { x = d; y = v; } else { x = v; y = l; }
    if (!(x >= 0 && y > 0)) continue;

    const ar = getAnomalyRatio(p);
    const strength = Math.max(0.15, Math.min(1.0, Math.log10(ar + 1) / 2.0));
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

/* ---------- main plot ---------- */
async function drawPlot(bundle) {
  const points = Array.isArray(bundle?.points) ? bundle.points : [];
  const baseline = bundle?.latest?.baseline || {};

  const rows = points.filter(p => {
    const v = getViews(p);
    const l = getLikes(p);
    const d = getDays(p);
    if (!(v > 0 && l > 0)) return false;
    if (state.mode === "views_days") return d >= 1;
    return true;
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
    const label = getLabel(p);
    const ar = getAnomalyRatio(p);
    const rn = getRatioNat(p);
    const rl = getRatioLike(p);

    let x, y;
    if (state.mode === "views_days") { x = d; y = v; } else { x = v; y = l; }

    xs.push(x);
    ys.push(y);
    colors.push(LABEL_COLOR[label] || "#94a3b8");
    sizes.push(label === "RED" ? 9 : (label === "ORANGE" ? 7 : 6));

    hover.push([
      `<b>${escapeHtml(title)}</b>`,
      `label: <b>${escapeHtml(label)}</b>`,
      `days: ${Number.isFinite(d) ? d.toFixed(2) : "?"}`,
      `views: ${Number.isFinite(v) ? fmtInt(v) : "?"}`,
      `likes: ${Number.isFinite(l) ? fmtInt(l) : "?"}`,
      `ratio_nat: ${Number.isFinite(rn) ? rn.toFixed(2) : "?"}`,
      `ratio_like: ${Number.isFinite(rl) ? rl.toFixed(2) : "?"}`,
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
    layout.title = { text: "再生数乖離評価", x: 0.02 };
    layout.xaxis = { title: "days since publish", type: "linear", gridcolor: "rgba(255,255,255,0.06)" };
    layout.yaxis = { title: "views", type: state.yLog ? "log" : "linear", gridcolor: "rgba(255,255,255,0.06)" };
  } else {
    layout.title = { text: "高評価乖離評価", x: 0.02 };
    layout.xaxis = { title: "views", type: "log", gridcolor: "rgba(255,255,255,0.06)" };
    layout.yaxis = { title: "likes", type: "log", gridcolor: "rgba(255,255,255,0.06)" };
  }

  await Plotly.newPlot("plot", [scatter, ...lines], layout, { displayModeBar:true, responsive:true });

  state.redPlotPoints = computeRedPlotPoints(rows, state.mode);
  syncPulseCanvasToPlot();
  ensurePulseLoop();
  attachPlotEventsOnce();

  updateYScaleButtons();
  renderBaselineInfo(bundle);
}

/* ---------- RED list ---------- */
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

  const list = redTop.slice(0, 30).map((x) => {
    const id = getVideoId(x) || x.video_id || x.id || "";
    return lookup.get(id) || x;
  });

  if (!list.length) {
    root.innerHTML = `<div class="item"><div class="m">異常値が上位の動画がありません</div></div>`;
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

/* ---------- boot ---------- */
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
    if (!input) {
      showManualHint("入力してください。");
      return;
    }

    try {
      if (btn) btn.disabled = true;

      // まず「既に監視されているなら即表示」
      const already = findChannelIdByManualInput(input);
      if (already) {
        showManualHint("");
        await setChannel(already);
        return;
      }

      // オンデマンド起動
      showManualHint("解析中…（オンデマンド起動 → Pages反映待ち）");
      const res = await startOndemand(input);

      // Workerが channel_id を返す場合はそれを優先
      let channelId =
        (res && (res.channel_id || res.channelId || res.id)) ||
        (input.startsWith("UC") ? input : null);

      // @handle 等でID不明な場合は index.json 反映を待って解決
      if (!channelId) {
        showManualHint("解析中…（index更新待ち）");
        channelId = await waitChannelIdFromIndex(input);
      }

      if (!channelId) {
        showManualHint("オンデマンドは起動しましたが、チャンネルが index に反映されませんでした。しばらく待って再試行してください。");
        return;
      }

      // 生成物（latest_points.json）反映待ち
      showManualHint("解析中…（データ生成待ち）");
      const ok = await waitChannelDataReady(channelId);
      if (!ok) {
        showManualHint("解析は起動しましたが、データがまだ反映されていません。少し待ってから再試行してください。");
        return;
      }

      // index更新→表示
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
