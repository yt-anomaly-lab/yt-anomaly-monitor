/* global Plotly */

const DATA_BASE = "./data";

/* 点の色（ラベル別） */
const LABEL_COLOR = {
  NORMAL: "#3b82f6",
  YELLOW: "#facc15",
  ORANGE: "#fb923c",
  RED: "#ef4444",
};

const $ = (sel) => document.querySelector(sel);

const state = {
  index: null,
  currentChannelId: null,
  mode: "views_days",   // "views_days" | "views_likes"
  yLog: true,           // ★自然流入図(views_days)の縦軸 log on/off
  channelCache: new Map(),

  redPlotPoints: [],    // {x, y, strength, title, videoId}
  pulseRunning: false,
  pulseT: 0,
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
function getChannelId(ch) {
  return ch?.channel_id || ch?.channelId || ch?.id || "";
}
function getChannelTitle(ch) {
  return ch?.title || ch?.handle || ch?.watch_key || ch?.watchKey || getChannelId(ch) || "(unknown)";
}
function getStickyCount(ch) {
  return safeNum(ch?.sticky_red_count, safeNum(ch?.sticky_red, safeNum(ch?.sticky, 0)));
}
function getWorstAnomaly(ch) {
  return safeNum(ch?.max_anomaly_ratio, safeNum(ch?.worst_anomaly, safeNum(ch?.worst, NaN)));
}

/* ---------- latest_points.json（あなたの形式） ---------- */
function normalizePoints(pointsJson) {
  if (Array.isArray(pointsJson)) return pointsJson;
  if (pointsJson && Array.isArray(pointsJson.points)) return pointsJson.points;
  if (pointsJson && Array.isArray(pointsJson.items)) return pointsJson.items;
  return [];
}

function getVideoId(p) {
  return p?.videoId || p?.video_id || p?.id || p?.contentDetails?.videoId || "";
}
function getTitle(p) {
  return p?.title || p?.snippet?.title || "(no title)";
}
function getDays(p) {
  const d = pick(p, ["days", "days_since_publish", "daysSincePublish"]);
  const dn = safeNum(d, NaN);
  if (dn >= 0) return dn;

  const pub = p?.publishedAt || p?.snippet?.publishedAt;
  if (!pub) return NaN;
  const pubMs = Date.parse(pub);
  if (!Number.isFinite(pubMs)) return NaN;
  const diff = (Date.now() - pubMs) / (1000 * 60 * 60 * 24);
  return diff >= 0 ? diff : NaN;
}
function getViews(p) {
  const v =
    pick(p, ["views", "view_count", "viewCount"]) ??
    pick(p?.statistics, ["viewCount"]);
  return safeNum(v, NaN);
}
function getLikes(p) {
  const v =
    pick(p, ["likes", "like_count", "likeCount"]) ??
    pick(p?.statistics, ["likeCount"]);
  return safeNum(v, NaN);
}
function getLabel(p) {
  return String(
    pick(p, ["display_label", "observed_label", "label", "level"]) ?? "NORMAL"
  ).toUpperCase();
}
function getAnomalyRatio(p) {
  return safeNum(pick(p, ["anomaly_ratio", "anomalyRatio", "anomaly"]) ?? NaN, NaN);
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
  drawPlot(bundle);
  renderRedList(bundle);
}

function renderBaselineInfo(bundle) {
  const b = bundle?.latest?.baseline || {};
  const a = safeNum(b.a, NaN);
  const bb = safeNum(b.b, NaN);
  const upper = safeNum(b.upper_ratio_ref, NaN);
  const medLike = safeNum(b.med_like_rate, NaN);

  const title =
    bundle?.channel?.title ||
    bundle?.channel?.handle ||
    state.currentChannelId ||
    "(unknown)";

  $("#baselineInfo").textContent =
    `Channel: ${title}` +
    ` / a=${Number.isFinite(a) ? a.toFixed(3) : "?"}` +
    ` b=${Number.isFinite(bb) ? bb.toFixed(3) : "?"}` +
    ` upper_ratio_ref=${Number.isFinite(upper) ? upper.toFixed(2) : "?"}` +
    ` med_like_rate=${Number.isFinite(medLike) ? medLike.toExponential(2) : "?"}` +
    ` / points=${Array.isArray(bundle?.points) ? bundle.points.length : 0}` +
    ` / y=${state.mode === "views_days" ? (state.yLog ? "log" : "linear") : "log"}`;
}

/* ---------- baseline 線 ---------- */
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
    arr.push(Math.pow(10, lo + (hi - lo) * t));
  }
  return arr;
}

function buildBaselineTraces(mode, rows, baseline) {
  const a = safeNum(baseline?.a, NaN);
  const b = safeNum(baseline?.b, NaN);
  const upperRatio = safeNum(baseline?.upper_ratio_ref, NaN);
  const medLikeRate = safeNum(baseline?.med_like_rate, NaN);

  if (!rows.length) return [];
  const N = 120;

  if (mode === "views_likes") {
    const viewsArr = rows.map((p) => getViews(p)).filter((v) => v > 0);
    if (!viewsArr.length || !(medLikeRate > 0)) return [];

    const xmin = Math.min(...viewsArr);
    const xmax = Math.max(...viewsArr);
    const xs = logspace(xmin, xmax, N);
    const ys = xs.map((v) => v * medLikeRate);

    const traces = [
      { type: "scatter", mode: "lines", name: "expected", x: xs, y: ys, hoverinfo: "skip", line: { width: 2, dash: "solid" } },
    ];
    if (upperRatio > 0) {
      traces.push({
        type: "scatter",
        mode: "lines",
        name: "upper",
        x: xs,
        y: ys.map((v) => v * upperRatio),
        hoverinfo: "skip",
        line: { width: 2, dash: "dot" },
      });
    }
    return traces;
  }

  // views_days：横軸はリニア固定なので linspace
  const daysArr = rows.map((p) => getDays(p)).filter((v) => v >= 0);
  if (!daysArr.length || !(Number.isFinite(a) && Number.isFinite(b))) return [];

  const xmin = Math.min(...daysArr);
  const xmax = Math.max(...daysArr);

  const xs = linspace(Math.max(0, xmin), Math.max(0, xmax), N);

  const pred = xs.map((d) => {
    // log-log 回帰式から期待値を出す（d=0 回避）
    const dd = Math.max(1e-6, d);
    const lv = a + b * Math.log10(dd);
    return Math.pow(10, lv);
  });

  const traces = [
    { type: "scatter", mode: "lines", name: "expected", x: xs, y: pred, hoverinfo: "skip", line: { width: 2, dash: "solid" } },
  ];
  if (upperRatio > 0) {
    traces.push({
      type: "scatter",
      mode: "lines",
      name: "upper",
      x: xs,
      y: pred.map((v) => v * upperRatio),
      hoverinfo: "skip",
      line: { width: 2, dash: "dot" },
    });
  }
  return traces;
}

/* ---------- Plot + 赤点パルス ---------- */
function computeRedPlotPoints(rows, mode) {
  const red = [];
  for (const p of rows) {
    const label = getLabel(p);
    const isRed = (label === "RED") || (p?.sticky_red === true);
    if (!isRed) continue;

    const views = getViews(p);
    const likes = getLikes(p);
    const days = getDays(p);

    let x, y;
    if (mode === "views_likes") {
      x = views; y = likes;
    } else {
      x = days; y = views;
    }
    if (!(x >= 0 && y > 0)) continue;

    const ar = getAnomalyRatio(p);
    const strength = Math.max(0.15, Math.min(1.0, Math.log10(ar + 1) / 2.0));

    red.push({ x, y, strength, title: getTitle(p), videoId: getVideoId(p), anomaly: ar });
  }
  return red;
}

function syncPulseCanvasToPlot() {
  const gd = $("#plot");
  const c = $("#plotPulse");
  if (!gd || !c || !gd._fullLayout) return;

  const fl = gd._fullLayout;
  const sz = fl._size; // {l,t,w,h}
  if (!sz) return;

  c.style.left = `${sz.l}px`;
  c.style.top = `${sz.t}px`;
  c.style.right = "auto";
  c.style.bottom = "auto";
  c.style.width = `${sz.w}px`;
  c.style.height = `${sz.h}px`;
  c.style.position = "absolute";

  const dpr = window.devicePixelRatio || 1;
  c.width = Math.max(1, Math.floor(sz.w * dpr));
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
  const c = $("#plotPulse");
  if (!gd || !c) return;
  const ctx = c.getContext("2d");
  if (!ctx) return;

  const dpr = window.devicePixelRatio || 1;
  const w = c.width;
  const h = c.height;

  ctx.clearRect(0, 0, w, h);

  const t = state.pulseT;
  const points = state.redPlotPoints;
  if (!points || points.length === 0) return;

  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const xy = dataToPixel(gd, p.x, p.y);
    if (!xy) continue;

    const x = xy.px * dpr;
    const y = xy.py * dpr;
    if (!(x >= -50 && x <= w + 50 && y >= -50 && y <= h + 50)) continue;

    const phase = (i * 17) % 97;
    const beat = 0.5 + 0.5 * Math.sin((t * 0.22) + phase) * Math.sin((t * 0.07) + phase * 0.3);

    const alpha = (0.10 + 0.28 * p.strength) * beat;
    const baseR = (8 + 14 * p.strength) * dpr;
    const gap = (7 + 10 * p.strength) * dpr;

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
function stopPulseLoop() {
  state.pulseRunning = false;
}

/* Plotlyイベントの多重登録防止 */
let plotEventsAttached = false;
function attachPlotEventsOnce() {
  if (plotEventsAttached) return;
  plotEventsAttached = true;

  const gd = $("#plot");
  if (!gd) return;

  gd.on("plotly_afterplot", () => syncPulseCanvasToPlot());
  gd.on("plotly_relayout", () => syncPulseCanvasToPlot());

  window.addEventListener("resize", () => syncPulseCanvasToPlot());
}

async function drawPlot(bundle) {
  const points = Array.isArray(bundle?.points) ? bundle.points : [];
  const baseline = bundle?.latest?.baseline || {};

  const rows = points.filter((p) => {
    const views = getViews(p);
    const days = getDays(p);
    const likes = getLikes(p);

    if (!(views > 0)) return false;

    if (state.mode === "views_days") {
      return days >= 0;
    }
    return likes > 0;
  });

  const x = [];
  const y = [];
  const hover = [];
  const colors = [];
  const sizes = [];

  for (const p of rows) {
    const videoId = getVideoId(p);
    const title = getTitle(p);
    const days = getDays(p);
    const views = getViews(p);
    const likes = getLikes(p);
    const anomaly = getAnomalyRatio(p);
    const label = getLabel(p);

    let xv, yv;
    if (state.mode === "views_likes") {
      xv = views; yv = likes;
    } else {
      xv = days; yv = views;
    }

    x.push(xv);
    y.push(yv);

    colors.push(LABEL_COLOR[label] || "#94a3b8");
    sizes.push(label === "RED" ? 9 : (label === "ORANGE" ? 7 : 6));

    const url = youtubeUrl(videoId);
    hover.push([
      `<b>${escapeHtml(title)}</b>`,
      `label: <b>${escapeHtml(label)}</b>`,
      `days: ${Number.isFinite(days) ? days.toFixed(2) : "?"}`,
      `views: ${Number.isFinite(views) ? fmtInt(views) : "?"}`,
      `likes: ${Number.isFinite(likes) ? fmtInt(likes) : "?"}`,
      `anomaly_ratio: ${Number.isFinite(anomaly) ? anomaly.toFixed(2) : "?"}`,
      `<a href="${url}" target="_blank" rel="noreferrer">open</a>`,
    ].join("<br>"));
  }

  const scatter = {
    type: "scattergl",
    mode: "markers",
    name: "videos",
    x,
    y,
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
    xaxis: {},
    yaxis: {},
  };

  if (state.mode === "views_likes") {
    layout.title = { text: "Views × Likes（log-log）", x: 0.02 };
    layout.xaxis = { title: "views", type: "log", gridcolor: "rgba(255,255,255,0.06)" };
    layout.yaxis = { title: "likes", type: "log", gridcolor: "rgba(255,255,255,0.06)" };
  } else {
    layout.title = { text: "Days × Views（x: linear固定 / y: log切替）", x: 0.02 };
    // ★横軸は常に linear
    layout.xaxis = { title: "days since publish", type: "linear", gridcolor: "rgba(255,255,255,0.06)" };
    // ★縦軸はトグル
    layout.yaxis = { title: "views", type: state.yLog ? "log" : "linear", gridcolor: "rgba(255,255,255,0.06)" };
  }

  await Plotly.newPlot("plot", [scatter, ...lines], layout, {
    displayModeBar: true,
    responsive: true,
  });

  // 赤点パルス
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
    const id = getVideoId(x) || x.video_id || x.videoId || x.id || "";
    return lookup.get(id) || x;
  });

  if (!list.length) {
    root.innerHTML = `<div class="item"><div class="m">RED上位がありません</div></div>`;
    return;
  }

  for (const p of list) {
    const id = getVideoId(p) || p.video_id || "";
    const title = getTitle(p);
    const anomaly = getAnomalyRatio(p);
    const views = getViews(p);
    const likes = getLikes(p);
    const url = youtubeUrl(id);

    const div = document.createElement("div");
    div.className = "item";
    div.innerHTML = `
      <div class="t"><a href="${url}" target="_blank" rel="noreferrer">${escapeHtml(title)}</a></div>
      <div class="m">anomaly_ratio: ${Number.isFinite(anomaly) ? anomaly.toFixed(2) : "?"} / views: ${Number.isFinite(views) ? fmtInt(views) : "?"} / likes: ${Number.isFinite(likes) ? fmtInt(likes) : "?"}</div>
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

  updateYScaleButtons();

  const index = await fetchJson(`${DATA_BASE}/index.json`);
  state.index = index;

  renderChannelList(index);
  renderChannelSelect(index);

  const first = Array.isArray(index?.channels) ? index.channels[0] : null;
  const channelId = getChannelId(first);

  if (channelId) {
    await setChannel(channelId);
  } else {
    await Plotly.newPlot("plot", [], { title: "no channel" }, { responsive: true });
    stopPulseLoop();
  }
}

boot().catch((e) => {
  console.error(e);
  const el = $("#baselineInfo");
  if (el) el.textContent = `boot error: ${e?.message || e}`;
});
