/* global Plotly */

const DATA_BASE = "./data";

// ln/exp前提（あなたのメモ通り）
const UPPER_MULT = 1.00;

const LABEL_COLOR = {
  NORMAL: "#94a3b8",
  YELLOW: "#facc15",
  ORANGE: "#fb923c",
  RED: "#ef4444",
};

const $ = (sel) => document.querySelector(sel);

const state = {
  index: null,
  currentChannelId: null,
  cache: new Map(),
};

function safeNum(v, dflt = NaN) {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}
function fmtInt(n) {
  n = safeNum(n, 0);
  return Number.isFinite(n) ? n.toLocaleString("en-US") : "?";
}
function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
async function fetchJson(path) {
  const r = await fetch(path, { cache: "no-store" });
  if (!r.ok) throw new Error(`fetch failed: ${path} (${r.status})`);
  return await r.json();
}
function pick(obj, keys) {
  for (const k of keys) if (obj && obj[k] != null) return obj[k];
  return undefined;
}

/* ---- index.json 互換 ---- */
function getChannelId(ch) { return ch?.channel_id || ch?.channelId || ch?.id || ""; }
function getChannelTitle(ch) { return ch?.title || ch?.handle || ch?.watch_key || ch?.watchKey || getChannelId(ch) || "(unknown)"; }
function getStickyCount(ch) { return safeNum(ch?.sticky_red_count, safeNum(ch?.sticky_red, safeNum(ch?.sticky, 0))); }
function getWorstAnomaly(ch) { return safeNum(ch?.max_anomaly_ratio, safeNum(ch?.worst_anomaly, safeNum(ch?.worst, NaN))); }

/* ---- points 互換 ---- */
function normalizePoints(pointsJson) {
  if (Array.isArray(pointsJson)) return pointsJson;
  if (pointsJson && Array.isArray(pointsJson.points)) return pointsJson.points;
  if (pointsJson && Array.isArray(pointsJson.items)) return pointsJson.items;
  return [];
}
function getVideoId(p) { return p?.videoId || p?.video_id || p?.id || ""; }
function getTitle(p) { return p?.title || "(no title)"; }
function getDays(p) { return safeNum(p?.t_days, safeNum(p?.days, NaN)); }
function getViews(p) { return safeNum(p?.viewCount, safeNum(p?.views, NaN)); }
function getLikes(p) { return safeNum(p?.likeCount, safeNum(p?.likes, NaN)); }
function getLabel(p) { return String(pick(p, ["display_label", "observed_label", "label"]) ?? "NORMAL").toUpperCase(); }
function getAnomalyRatio(p) { return safeNum(p?.anomaly_ratio, NaN); }
function getRatioNat(p) { return safeNum(p?.ratio_nat, NaN); }
function getRatioLike(p) { return safeNum(p?.ratio_like, NaN); }

function linspace(xmin, xmax, n) {
  if (n <= 1) return [xmin];
  const a = [];
  const step = (xmax - xmin) / (n - 1);
  for (let i = 0; i < n; i++) a.push(xmin + step * i);
  return a;
}

/* ---- baseline traces（あなたの修正済みロジック前提） ---- */
function buildBaselineTracesViewsDays(rows, baseline) {
  const a = safeNum(baseline?.a_days, NaN);
  const b = safeNum(baseline?.b_days, NaN);
  const NAT_UP = safeNum(baseline?.NAT_UPPER_RATIO, NaN) * UPPER_MULT;
  if (!(Number.isFinite(a) && Number.isFinite(b) && Number.isFinite(NAT_UP))) return [];

  const daysArr = rows.map(getDays).filter(v => Number.isFinite(v));
  const tmax = Math.max(...daysArr, 1);
  const t_line = linspace(1, tmax, 400);

  const log_center = t_line.map(t => a + b * t);                 // ln(V)
  const log_upper  = log_center.map(lv => lv + Math.log(NAT_UP)); // lnで +ln

  const v_center = log_center.map(lv => Math.exp(lv));
  const v_upper  = log_upper.map(lv => Math.exp(lv));

  return [
    { type:"scatter", mode:"lines", name:"expected", x:t_line, y:v_center, hoverinfo:"skip", line:{ width:2 } },
    { type:"scatter", mode:"lines", name:"upper",    x:t_line, y:v_upper,  hoverinfo:"skip", line:{ width:2, dash:"dot" } },
  ];
}

function buildBaselineTracesViewsLikes(rows, baseline) {
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
    { type:"scatter", mode:"lines", name:"expected", x:views_line, y:likes_line, hoverinfo:"skip", line:{ width:2 } },
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

/* ---- UI ---- */
function renderChannelList(index) {
  const root = $("#channel-list");
  if (!root) return;
  root.innerHTML = "";

  const arr = Array.isArray(index?.channels) ? index.channels : [];
  const filtered = arr
    .filter(ch => getStickyCount(ch) > 0)              // ★red0を表示しない
    .sort((a,b) => (getStickyCount(b)-getStickyCount(a)) || (getWorstAnomaly(b)-getWorstAnomaly(a)));

  for (const ch of filtered) {
    const id = getChannelId(ch);
    const div = document.createElement("div");
    div.className = "item";
    div.setAttribute("data-channel-id", id);

    div.innerHTML = `
      <div class="t">${escapeHtml(getChannelTitle(ch))}</div>
      <div class="m">RED: ${getStickyCount(ch)} / worst: ${Number.isFinite(getWorstAnomaly(ch)) ? getWorstAnomaly(ch).toFixed(2) : "?"}</div>
    `;

    div.addEventListener("click", () => setChannel(id));
    root.appendChild(div);
  }
  updateActiveChannelInList();
}

function updateActiveChannelInList() {
  const root = $("#channel-list");
  if (!root) return;
  root.querySelectorAll(".item").forEach(el => {
    const id = el.getAttribute("data-channel-id") || "";
    el.classList.toggle("active", id && id === state.currentChannelId);
  });
}

function cssClassForLabel(label) {
  const L = String(label || "").toUpperCase();
  if (L === "RED") return "red";
  if (L === "ORANGE") return "orange";
  if (L === "YELLOW") return "yellow";
  return "";
}

function renderRedTop(bundle) {
  const root = $("#red-top");
  if (!root) return;
  root.innerHTML = "";

  const points = Array.isArray(bundle?.points) ? bundle.points : [];
  const red = points
    .filter(p => getLabel(p) === "RED")
    .sort((a,b) => safeNum(getAnomalyRatio(b),0) - safeNum(getAnomalyRatio(a),0))
    .slice(0, 30);

  if (!red.length) {
    root.innerHTML = `<div class="item"><div class="m">異常値が上位の動画がありません</div></div>`;
    return;
  }

  for (const p of red) {
    const div = document.createElement("div");
    const cls = cssClassForLabel(getLabel(p));
    div.className = `item ${cls}`.trim();
    div.innerHTML = `
      <div class="t">${escapeHtml(getTitle(p))}</div>
      <div class="m">anomaly: ${Number.isFinite(getAnomalyRatio(p)) ? getAnomalyRatio(p).toFixed(2) : "?"} / views: ${fmtInt(getViews(p))} / likes: ${fmtInt(getLikes(p))}</div>
    `;
    root.appendChild(div);
  }
}

async function loadChannelBundle(channelId) {
  if (state.cache.has(channelId)) return state.cache.get(channelId);

  const base = `${DATA_BASE}/channels/${encodeURIComponent(channelId)}`;
  const [latest, pointsJson] = await Promise.all([
    fetchJson(`${base}/latest.json`).catch(() => ({})),
    fetchJson(`${base}/latest_points.json`).catch(() => ({})),
  ]);

  const bundle = { latest, points: normalizePoints(pointsJson) };
  state.cache.set(channelId, bundle);
  return bundle;
}

async function setChannel(channelId) {
  if (!channelId) return;
  state.currentChannelId = channelId;
  updateActiveChannelInList();

  const bundle = await loadChannelBundle(channelId);
  renderRedTop(bundle);
  drawViewsDays(bundle);
  drawViewsLikes(bundle);
}

function drawViewsDays(bundle) {
  const el = $("#views-days");
  if (!el) return;

  const baseline = bundle?.latest?.baseline || {};
  const rows = (bundle?.points || []).filter(p => getViews(p) > 0 && getLikes(p) > 0 && getDays(p) >= 1);

  const x = rows.map(getDays);
  const y = rows.map(getViews);
  const label = rows.map(getLabel);

  const trace = {
    type: "scattergl",
    mode: "markers",
    name: "videos",
    x, y,
    text: rows.map(p => [
      `<b>${escapeHtml(getTitle(p))}</b>`,
      `label: <b>${escapeHtml(getLabel(p))}</b>`,
      `days: ${Number.isFinite(getDays(p)) ? getDays(p).toFixed(2) : "?"}`,
      `views: ${fmtInt(getViews(p))}`,
      `likes: ${fmtInt(getLikes(p))}`,
      `ratio_nat: ${Number.isFinite(getRatioNat(p)) ? getRatioNat(p).toFixed(2) : "?"}`,
      `anomaly_ratio: ${Number.isFinite(getAnomalyRatio(p)) ? getAnomalyRatio(p).toFixed(2) : "?"}`,
    ].join("<br>")),
    hoverinfo: "text",
    marker: {
      size: label.map(l => (l === "RED" ? 9 : (l === "ORANGE" ? 7 : 6))),
      color: label.map(l => LABEL_COLOR[l] || LABEL_COLOR.NORMAL),
      opacity: 0.9
    }
  };

  const lines = buildBaselineTracesViewsDays(rows, baseline);

  const layout = {
    title: { text: "再生数乖離評価", x: 0.02 },
    margin: { l: 60, r: 20, t: 40, b: 60 },
    paper_bgcolor: "rgba(0,0,0,0)",
    plot_bgcolor: "rgba(0,0,0,0)",
    xaxis: { title: "公開日数", type: "linear", gridcolor: "rgba(255,255,255,0.06)" },
    yaxis: { title: "再生数", type: "linear", gridcolor: "rgba(255,255,255,0.06)" }, // ★デフォルトはリニア
    legend: { orientation: "h", x: 0, y: 1.1 },
    showlegend: true,
  };

  Plotly.newPlot(el, [trace, ...lines], layout, { displayModeBar: true, responsive: true });
}

function drawViewsLikes(bundle) {
  const el = $("#views-likes");
  if (!el) return;

  const baseline = bundle?.latest?.baseline || {};
  const rows = (bundle?.points || []).filter(p => getViews(p) > 0 && getLikes(p) > 0);

  const x = rows.map(getViews);
  const y = rows.map(getLikes);
  const label = rows.map(getLabel);

  const trace = {
    type: "scattergl",
    mode: "markers",
    name: "videos",
    x, y,
    text: rows.map(p => [
      `<b>${escapeHtml(getTitle(p))}</b>`,
      `label: <b>${escapeHtml(getLabel(p))}</b>`,
      `views: ${fmtInt(getViews(p))}`,
      `likes: ${fmtInt(getLikes(p))}`,
      `ratio_like: ${Number.isFinite(getRatioLike(p)) ? getRatioLike(p).toFixed(2) : "?"}`,
      `anomaly_ratio: ${Number.isFinite(getAnomalyRatio(p)) ? getAnomalyRatio(p).toFixed(2) : "?"}`,
    ].join("<br>")),
    hoverinfo: "text",
    marker: {
      size: label.map(l => (l === "RED" ? 9 : (l === "ORANGE" ? 7 : 6))),
      color: label.map(l => LABEL_COLOR[l] || LABEL_COLOR.NORMAL),
      opacity: 0.9
    }
  };

  const lines = buildBaselineTracesViewsLikes(rows, baseline);

  const layout = {
    title: { text: "高評価乖離評価", x: 0.02 },
    margin: { l: 60, r: 20, t: 40, b: 60 },
    paper_bgcolor: "rgba(0,0,0,0)",
    plot_bgcolor: "rgba(0,0,0,0)",
    xaxis: { title: "再生数", type: "log", gridcolor: "rgba(255,255,255,0.06)" },
    yaxis: { title: "高評価数", type: "log", gridcolor: "rgba(255,255,255,0.06)" },
    legend: { orientation: "h", x: 0, y: 1.1 },
    showlegend: true,
  };

  Plotly.newPlot(el, [trace, ...lines], layout, { displayModeBar: true, responsive: true });
}

/* ---- boot ---- */
async function boot() {
  const index = await fetchJson(`${DATA_BASE}/index.json?ts=${Date.now()}`);
  state.index = index;

  renderChannelList(index);

  // 先頭（red>0でフィルタ後）を開く
  const arr = Array.isArray(index?.channels) ? index.channels : [];
  const first = arr.filter(ch => getStickyCount(ch) > 0)[0] || arr[0];
  const id = getChannelId(first);
  if (id) await setChannel(id);
}

boot().catch((e) => {
  console.error(e);
  const root = $("#channel-list");
  if (root) {
    root.innerHTML = `<div class="item red"><div class="t">boot error</div><div class="m">${escapeHtml(e?.message || String(e))}</div></div>`;
  }
});
