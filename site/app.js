/* global Plotly */

const DATA_BASE = "./data";

/* =========================
 * ★ パラメータ類（要望(5)）
 * ========================= */
const PULSE_SPEED = 1.0;     // 1.0=標準。0.5で半分の速さ、2.0で倍速
const UPPER_MULT  = 1.0;     // 上限倍率の追加係数（baseline.upper_ratio_ref * UPPER_MULT）

/* 点の色 */
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
  mode: "views_days", // "views_days" | "views_likes"
  yLog: true,         // views_days の縦軸 log on/off
  inputMode: "select",// "select" | "manual"
  channelCache: new Map(),

  redPlotPoints: [],  // {x, y, strength}
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

function getVideoId(p) { return p?.videoId || p?.video_id || p?.id || ""; }
function getTitle(p)   { return p?.title || "(no title)"; }

function getDays(p) {
  const d = pick(p, ["days", "t_days"]);
  const dn = safeNum(d, NaN);
  if (dn >= 0) return dn;
  const pub = p?.publishedAt;
  if (!pub) return NaN;
  const pubMs = Date.parse(pub);
  if (!Number.isFinite(pubMs)) return NaN;
  const diff = (Date.now() - pubMs) / (1000 * 60 * 60 * 24);
  return diff >= 0 ? diff : NaN;
}

function getViews(p) {
  const v = pick(p, ["viewCount", "views", "view_count", "viewCount"]);
  return safeNum(v, NaN);
}
function getLikes(p) {
  const v = pick(p, ["likeCount", "likes", "like_count", "likeCount"]);
  return safeNum(v, NaN);
}
function getLabel(p) {
  return String(pick(p, ["display_label", "observed_label", "label"]) ?? "NORMAL").toUpperCase();
}
function getAnomalyRatio(p) {
  return safeNum(pick(p, ["anomaly_ratio", "anomalyRatio"]) ?? NaN, NaN);
}
function getRatioNat(p) {
  return safeNum(pick(p, ["ratio_nat"]) ?? NaN, NaN);
}
function getRatioLike(p) {
  return safeNum(pick(p, ["ratio_like"]) ?? NaN, NaN);
}

/* ---------- 入力モード切替（要望(3)） ---------- */
function setInputMode(mode) {
  state.inputMode = mode;
  $("#btnInputSelect")?.classList.toggle("active", mode === "select");
  $("#btnInputManual")?.classList.toggle("active", mode === "manual");

  $("#selectBox")?.classList.toggle("hidden", mode !== "select");
  $("#manualBox")?.classList.toggle("hidden", mode !== "manual");
}

function findChannelIdByManualInput(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;

  // UC... はそのまま
  if (s.startsWith("UC")) return s;

  // @handle の場合: index.json の watch_key / handle / title で探す（静的なので監視済みのみ）
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

function showManualHint(msg) {
  const el = $("#manualHint");
  if (el) el.textContent = msg || "";
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
  await drawPlot(bundle);
  renderRedList(bundle);
}

/* =========================
 * 期待線描画（要望(1)(2)）
 * ========================= */

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
  if (!rows.length) return [];

  const N = 180;

  // 上限倍率（フロント側で追加係数を掛ける）
  const upperRatio = safeNum(baseline?.upper_ratio_ref, NaN) * UPPER_MULT;

  if (mode === "views_days") {
    // ★ log-リニア: log10(Views) = a + b*days  （make_plots.py準拠） :contentReference[oaicite:4]{index=4}
    const a = safeNum(baseline?.nat_a, NaN);
    const b = safeNum(baseline?.nat_b, NaN);
    if (!(Number.isFinite(a) && Number.isFinite(b))) return [];

    const daysArr = rows.map(getDays).filter(v => v >= 0);
    if (!daysArr.length) return [];

    const xmin = Math.max(0, Math.min(...daysArr));
    const xmax = Math.max(...daysArr);
    const xs = linspace(xmin, xmax, N);

    const center = xs.map(d => Math.pow(10, a + b * d));
    const traces = [
      { type:"scatter", mode:"lines", name:"expected", x:xs, y:center, hoverinfo:"skip", line:{ width:2, dash:"solid" } }
    ];
    if (upperRatio > 0) {
      traces.push({
        type:"scatter", mode:"lines", name:"upper",
        x: xs, y: center.map(v => v * upperRatio),
        hoverinfo:"skip", line:{ width:2, dash:"dot" }
      });
    }
    return traces;
  }

  // views_likes
  // ★ logL→logV回帰: log10(Views) = b0 + b1*log10(Likes) （make_plots.py準拠） :contentReference[oaicite:5]{index=5}
  const b0 = safeNum(baseline?.like_b0, NaN);
  const b1 = safeNum(baseline?.like_b1, NaN);
  if (!(Number.isFinite(b0) && Number.isFinite(b1))) return [];

  const likesArr = rows.map(getLikes).filter(v => v > 0);
  if (!likesArr.length) return [];

  const ymin = Math.min(...likesArr);
  const ymax = Math.max(...likesArr);

  const ys = logspace(ymin, ymax, N);            // y=likes
  const xs = ys.map(l => Math.pow(10, b0 + b1 * Math.log10(l))); // x=expected views given likes

  const traces = [
    { type:"scatter", mode:"lines", name:"expected", x:xs, y:ys, hoverinfo:"skip", line:{ width:2, dash:"solid" } }
  ];

  if (upperRatio > 0) {
    // 上限は「期待Views * upperRatio」（右側へ）
    const xsUpper = xs.map(v => v * upperRatio);
    traces.push({
      type:"scatter", mode:"lines", name:"upper",
      x: xsUpper, y: ys,
      hoverinfo:"skip", line:{ width:2, dash:"dot" }
    });
  }
  return traces;
}

/* =========================
 * ドクドク（赤点に重ねる）
 * ========================= */

function computeRedPlotPoints(rows, mode) {
  const red = [];
  for (const p of rows) {
    const label = getLabel(p);
    const isRed = (label === "RED") || (p?.sticky_red === true);
    if (!isRed) continue;

    const views = getViews(p);
    const likes = getLikes(p);
    const days  = getDays(p);

    let x, y;
    if (mode === "views_days") { x = days;  y = views; }
    else { x = views; y = likes; }

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
  const sz = fl._size; // {l,t,w,h}
  if (!sz) return;

  c.style.left = `${sz.l}px`;
  c.style.top  = `${sz.t}px`;
  c.style.right = "auto";
  c.style.bottom = "auto";
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
    // ★速度パラメータ（要望(5)）
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

/* ---------- 描画本体 ---------- */

function renderBaselineInfo(bundle) {
  const b = bundle?.latest?.baseline || {};
  const title = bundle?.channel?.title || state.currentChannelId || "(unknown)";

  const natA = safeNum(b.nat_a, NaN);
  const natB = safeNum(b.nat_b, NaN);
  const likeB0 = safeNum(b.like_b0, NaN);
  const likeB1 = safeNum(b.like_b1, NaN);
  const upper = safeNum(b.upper_ratio_ref, NaN);

  $("#baselineInfo").textContent =
    `Channel: ${title}` +
    ` / upper=${Number.isFinite(upper) ? upper.toFixed(2) : "?"} * ${UPPER_MULT.toFixed(2)}` +
    ` / nat(a,b)=(${Number.isFinite(natA)?natA.toFixed(3):"?"}, ${Number.isFinite(natB)?natB.toExponential(2):"?"})` +
    ` / like(b0,b1)=(${Number.isFinite(likeB0)?likeB0.toFixed(3):"?"}, ${Number.isFinite(likeB1)?likeB1.toFixed(3):"?"})` +
    ` / y=${state.mode==="views_days" ? (state.yLog?"log":"linear") : "log"}` +
    ` / pulse_speed=${PULSE_SPEED.toFixed(2)}`;
}

async function drawPlot(bundle) {
  const points = Array.isArray(bundle?.points) ? bundle.points : [];
  const baseline = bundle?.latest?.baseline || {};

  // 表示対象（log軸の時は >0 必須）
  const rows = points.filter(p => {
    const v = getViews(p);
    const l = getLikes(p);
    const d = getDays(p);

    if (!(v > 0)) return false;

    if (state.mode === "views_days") {
      return d >= 0;
    }
    return l > 0;
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
    if (state.mode === "views_days") { x = d; y = v; }
    else { x = v; y = l; }

    xs.push(x);
    ys.push(y);

    colors.push(LABEL_COLOR[label] || "#94a3b8");
    sizes.push(label === "RED" ? 9 : (label === "ORANGE" ? 7 : 6));

    const url = youtubeUrl(id);
    hover.push([
      `<b>${escapeHtml(title)}</b>`,
      `label: <b>${escapeHtml(label)}</b>`,
      `days: ${Number.isFinite(d) ? d.toFixed(2) : "?"}`,
      `views: ${Number.isFinite(v) ? fmtInt(v) : "?"}`,
      `likes: ${Number.isFinite(l) ? fmtInt(l) : "?"}`,
      `ratio_nat: ${Number.isFinite(rn) ? rn.toFixed(2) : "?"}`,
      `ratio_like: ${Number.isFinite(rl) ? rl.toFixed(2) : "?"}`,
      `anomaly_ratio: ${Number.isFinite(ar) ? ar.toFixed(2) : "?"}`,
      `<a href="${url}" target="_blank" rel="noreferrer">open</a>`,
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
    xaxis: {},
    yaxis: {},
  };

  if (state.mode === "views_days") {
    layout.title = { text: "流入（x: days linear固定 / y: log切替）", x: 0.02 };
    layout.xaxis = { title: "days since publish", type: "linear", gridcolor: "rgba(255,255,255,0.06)" };
    layout.yaxis = { title: "views", type: state.yLog ? "log" : "linear", gridcolor: "rgba(255,255,255,0.06)" };
  } else {
    layout.title = { text: "高評価（log-log）", x: 0.02 };
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
    const ar = getAnomalyRatio(p);
    const v = getViews(p);
    const l = getLikes(p);
    const url = youtubeUrl(id);

    const div = document.createElement("div");
    div.className = "item";
    div.innerHTML = `
      <div class="t"><a href="${url}" target="_blank" rel="noreferrer">${escapeHtml(title)}</a></div>
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
    const raw = $("#channelInput")?.value || "";
    const id = findChannelIdByManualInput(raw);
    if (!id) {
      showManualHint("未監視のため表示できません（watchlistに追加して次回weeklyで生成してください）");
      return;
    }
    showManualHint("");
    await setChannel(id);
  });

  updateYScaleButtons();
  setInputMode("select");

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
  }
}

boot().catch((e) => {
  console.error(e);
  const el = $("#baselineInfo");
  if (el) el.textContent = `boot error: ${e?.message || e}`;
});
