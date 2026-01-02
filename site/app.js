/* global Plotly */

const DATA_BASE = "./data";
const $ = (sel) => document.querySelector(sel);

const state = {
  index: null,
  currentChannelId: null,
  mode: "views_days", // "views_days" | "views_likes"
  channelCache: new Map(), // channelId -> {channel, latest, points, state}
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

/* ---- 互換吸収レイヤ ---- */

function getChannelId(ch) {
  return ch?.channel_id || ch?.channelId || ch?.id || "";
}
function getChannelTitle(ch) {
  return ch?.title || ch?.handle || ch?.watch_key || ch?.watchKey || getChannelId(ch) || "(unknown)";
}
function getStickyCount(ch) {
  // index.json の揺れ吸収
  return safeNum(
    ch?.sticky_red_count,
    safeNum(ch?.sticky_red, safeNum(ch?.sticky, 0))
  );
}
function getWorstAnomaly(ch) {
  return safeNum(
    ch?.max_anomaly_ratio,
    safeNum(ch?.worst_anomaly, safeNum(ch?.worst, NaN))
  );
}

function pick(obj, keys) {
  for (const k of keys) {
    if (obj && obj[k] != null) return obj[k];
  }
  return undefined;
}

function getVideoId(p) {
  return (
    p?.videoId ||
    p?.video_id ||
    p?.videoID ||
    p?.id ||
    p?.contentDetails?.videoId ||
    p?.contentDetails?.video_id ||
    ""
  );
}
function getTitle(p) {
  return (
    p?.title ||
    p?.snippet?.title ||
    p?.video_title ||
    p?.name ||
    "(no title)"
  );
}
function getViews(p) {
  // ありがちな揺れ：views, view_count, viewCount, statistics.viewCount
  const v =
    pick(p, ["views", "view_count", "viewCount"]) ??
    pick(p?.statistics, ["viewCount", "view_count"]);
  return safeNum(v, NaN);
}
function getLikes(p) {
  const v =
    pick(p, ["likes", "like_count", "likeCount"]) ??
    pick(p?.statistics, ["likeCount", "like_count"]);
  return safeNum(v, NaN);
}
function getDays(p) {
  const v = pick(p, ["days", "days_since_publish", "daysSincePublish"]);
  return safeNum(v, NaN);
}
function getLabel(p) {
  return String(
    pick(p, ["label", "level", "anomaly_label", "anomalyLabel"]) ?? "NORMAL"
  ).toUpperCase();
}
function getAnomalyRatio(p) {
  return safeNum(
    pick(p, ["anomaly_ratio", "anomalyRatio", "anomaly"]) ?? NaN,
    NaN
  );
}
function getRatioNat(p) {
  return safeNum(pick(p, ["ratio_nat", "ratioNat"]) ?? NaN, NaN);
}
function getRatioLike(p) {
  return safeNum(pick(p, ["ratio_like", "ratioLike"]) ?? NaN, NaN);
}

/* ---- UI ---- */

function renderChannelList(index) {
  const root = $("#channelList");
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
  sel.innerHTML = "";

  const arr = Array.isArray(index?.channels) ? index.channels : [];
  arr.forEach((ch) => {
    const opt = document.createElement("option");
    opt.value = getChannelId(ch);

    const title = getChannelTitle(ch);
    const sticky = getStickyCount(ch);

    opt.textContent = `${title} (sticky_red=${sticky})`;
    sel.appendChild(opt);
  });

  sel.addEventListener("change", () => {
    const id = sel.value;
    if (id) setChannel(id);
  });
}

function setMode(mode) {
  state.mode = mode;
  $("#btnViewsDays").classList.toggle("active", mode === "views_days");
  $("#btnViewsLikes").classList.toggle("active", mode === "views_likes");

  if (state.currentChannelId) {
    const cached = state.channelCache.get(state.currentChannelId);
    if (cached) drawPlot(cached);
  }
}

async function loadChannelBundle(channelId) {
  if (state.channelCache.has(channelId)) return state.channelCache.get(channelId);

  const base = `${DATA_BASE}/channels/${channelId}`;
  const [channel, latest, points, st] = await Promise.all([
    fetchJson(`${base}/channel.json`).catch(() => ({})),
    fetchJson(`${base}/latest.json`).catch(() => ({})),
    fetchJson(`${base}/latest_points.json`).catch(() => ([])),
    fetchJson(`${base}/state.json`).catch(() => ({})),
  ]);

  const bundle = { channel, latest, points, state: st };
  state.channelCache.set(channelId, bundle);
  return bundle;
}

async function setChannel(channelId) {
  state.currentChannelId = channelId;
  $("#channelSelect").value = channelId;

  const bundle = await loadChannelBundle(channelId);
  renderBaselineInfo(bundle);
  drawPlot(bundle);
  renderRedList(bundle);
  startDokudoku(bundle);
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
    ` / baseline: a=${Number.isFinite(a) ? a.toFixed(3) : "?"}, b=${Number.isFinite(bb) ? bb.toFixed(3) : "?"}` +
    ` / upper_ratio_ref=${Number.isFinite(upper) ? upper.toFixed(2) : "?"}` +
    ` / med_like_rate=${Number.isFinite(medLike) ? medLike.toExponential(2) : "?"}`;
}

/* ---- Plot ---- */

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

function buildBaselineTraces(mode, rows, { a, b, upperRatio, medLikeRate }) {
  if (!rows.length) return [];
  const N = 80;

  if (mode === "views_likes") {
    const viewsArr = rows.map(getViews).filter((v) => v > 0);
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

  // views_days
  const daysArr = rows.map(getDays).filter((v) => v > 0);
  if (!daysArr.length || !(Number.isFinite(a) && Number.isFinite(b))) return [];

  const xmin = Math.min(...daysArr);
  const xmax = Math.max(...daysArr);
  const xs = logspace(xmin, xmax, N);

  const pred = xs.map((d) => {
    const ld = Math.log10(d);
    const lv = a + b * ld;
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

function drawPlot(bundle) {
  const points = Array.isArray(bundle?.points) ? bundle.points : [];
  const baseline = bundle?.latest?.baseline || {};
  const a = safeNum(baseline.a, NaN);
  const b = safeNum(baseline.b, NaN);
  const upperRatio = safeNum(baseline.upper_ratio_ref, NaN);
  const medLikeRate = safeNum(baseline.med_like_rate, NaN);

  // log軸に乗るものだけ（views>0, days>0）
  const rows = points.filter((p) => getViews(p) > 0 && getDays(p) > 0);

  const x = [];
  const y = [];
  const hover = [];

  for (const p of rows) {
    const videoId = getVideoId(p);
    const title = getTitle(p);
    const days = getDays(p);
    const views = getViews(p);
    const likes = getLikes(p);

    const ratioNat = getRatioNat(p);
    const ratioLike = getRatioLike(p);
    const anomaly = getAnomalyRatio(p);
    const label = getLabel(p);

    let xv, yv;
    if (state.mode === "views_likes") {
      if (!(views > 0 && likes > 0)) continue;
      xv = views;
      yv = likes;
    } else {
      xv = days;
      yv = views;
    }

    x.push(xv);
    y.push(yv);

    const url = youtubeUrl(videoId);
    const h = [
      `<b>${escapeHtml(title)}</b>`,
      `label: <b>${escapeHtml(label)}</b>`,
      `days: ${Number.isFinite(days) ? days.toFixed(1) : "?"}`,
      `views: ${Number.isFinite(views) ? fmtInt(views) : "?"}`,
      `likes: ${Number.isFinite(likes) ? fmtInt(likes) : "?"}`,
      `ratio_nat: ${Number.isFinite(ratioNat) ? ratioNat.toFixed(2) : "?"}`,
      `ratio_like: ${Number.isFinite(ratioLike) ? ratioLike.toFixed(2) : "?"}`,
      `anomaly_ratio: ${Number.isFinite(anomaly) ? anomaly.toFixed(2) : "?"}`,
      `<a href="${url}" target="_blank" rel="noreferrer">open</a>`,
    ].join("<br>");

    hover.push(h);
  }

  const scatter = {
    type: "scattergl",
    mode: "markers",
    name: "videos",
    x,
    y,
    text: hover,
    hoverinfo: "text",
    marker: { size: 6, opacity: 0.85 },
  };

  const lines = buildBaselineTraces(state.mode, rows, { a, b, upperRatio, medLikeRate });

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
    layout.title = { text: "Days × Views（log-log）", x: 0.02 };
    layout.xaxis = { title: "days since publish", type: "log", gridcolor: "rgba(255,255,255,0.06)" };
    layout.yaxis = { title: "views", type: "log", gridcolor: "rgba(255,255,255,0.06)" };
  }

  Plotly.newPlot("plot", [scatter, ...lines], layout, { displayModeBar: true, responsive: true });
}

/* ---- RED list & dokudoku ---- */

function normalizeRedTop(st) {
  // st.red_top が [ "id", ... ] でも [ {video_id:...}, ... ] でも吸収
  const raw = Array.isArray(st?.red_top) ? st.red_top : Array.isArray(st?.redTop) ? st.redTop : [];
  const out = [];
  for (const it of raw) {
    if (typeof it === "string") out.push({ videoId: it });
    else if (it && typeof it === "object") out.push(it);
  }
  return out;
}

function renderRedList(bundle) {
  const root = $("#redList");
  root.innerHTML = "";

  const st = bundle?.state || {};
  const redTop = normalizeRedTop(st);
  const points = Array.isArray(bundle?.points) ? bundle.points : [];

  // points から videoId を引けるようにする
  const lookup = new Map();
  for (const p of points) {
    const id = getVideoId(p);
    if (id) lookup.set(id, p);
  }

  const list = redTop.slice(0, 10).map((x) => {
    const id = getVideoId(x) || x.videoId || x.video_id || x.id || "";
    return lookup.get(id) || x;
  });

  if (!list.length) {
    root.innerHTML = `<div class="item"><div class="m">RED上位がありません</div></div>`;
    return;
  }

  for (const p of list) {
    const id = getVideoId(p);
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

let dokudokuTimer = null;
function startDokudoku(bundle) {
  const canvas = $("#dokudoku");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");

  const st = bundle?.state || {};
  const redTop = normalizeRedTop(st);
  const points = Array.isArray(bundle?.points) ? bundle.points : [];
  const lookup = new Map(points.map((p) => [getVideoId(p), p]));

  const list = redTop.slice(0, 10).map((x) => {
    const id = getVideoId(x) || x.videoId || x.video_id || x.id || "";
    return lookup.get(id) || x;
  }).filter(Boolean);

  if (dokudokuTimer) clearInterval(dokudokuTimer);

  let t = 0;
  dokudokuTimer = setInterval(() => {
    t += 1;

    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    ctx.fillStyle = "rgba(0,0,0,0.25)";
    ctx.fillRect(0, 0, w, h);

    const beat = 0.5 + 0.5 * Math.sin(t * 0.22) * Math.sin(t * 0.07);
    const rBase = 40 + beat * 25;

    const cx = w / 2, cy = h / 2;
    for (let i = 0; i < 6; i++) {
      const ph = t * 0.15 + i;
      const rr = rBase + i * 14 + 6 * Math.sin(ph);
      ctx.beginPath();
      ctx.arc(cx, cy, rr, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(255,255,255,${0.08 - i * 0.01})`;
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    ctx.fillStyle = "rgba(255,255,255,0.9)";
    ctx.font = "12px ui-sans-serif, system-ui";
    ctx.fillText("RED top10", 12, 22);

    ctx.fillStyle = "rgba(255,255,255,0.75)";
    ctx.font = "11px ui-sans-serif, system-ui";
    list.slice(0, 6).forEach((p, idx) => {
      const title = getTitle(p).slice(0, 22);
      const a = getAnomalyRatio(p);
      ctx.fillText(`${idx + 1}. ${title}  ${Number.isFinite(a) ? a.toFixed(2) : "?"}`, 12, 44 + idx * 18);
    });
  }, 50);
}

/* ---- boot ---- */

async function boot() {
  $("#btnViewsDays").addEventListener("click", () => setMode("views_days"));
  $("#btnViewsLikes").addEventListener("click", () => setMode("views_likes"));

  const index = await fetchJson(`${DATA_BASE}/index.json`);
  state.index = index;

  renderChannelList(index);
  renderChannelSelect(index);

  const first = Array.isArray(index?.channels) ? index.channels[0] : null;
  const channelId = getChannelId(first);
  if (channelId) {
    await setChannel(channelId);
  } else {
    Plotly.newPlot("plot", [], { title: "no channel" }, { responsive: true });
  }
}

boot().catch((e) => {
  console.error(e);
  const el = $("#baselineInfo");
  if (el) el.textContent = `boot error: ${e?.message || e}`;
});
