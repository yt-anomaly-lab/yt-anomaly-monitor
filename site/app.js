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

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function youtubeUrl(videoId) {
  return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId || "")}`;
}

async function fetchJson(path) {
  const r = await fetch(path, { cache: "no-store" });
  if (!r.ok) throw new Error(`fetch failed: ${path} (${r.status})`);
  return await r.json();
}

/**
 * index.json 想定（例）:
 * {
 *   "generated_at": "...",
 *   "channels": [
 *      {"channel_id":"UC...","title":"...","handle":"@...","worst_anomaly":12.3,"sticky_red":5}
 *   ],
 *   "red_top": [ ... optional ... ]
 * }
 */
function renderChannelList(index) {
  const root = $("#channelList");
  root.innerHTML = "";

  const arr = Array.isArray(index?.channels) ? index.channels : [];
  arr.slice(0, 60).forEach((ch) => {
    const div = document.createElement("div");
    div.className = "item";
    const title = ch.title || ch.handle || ch.channel_id || "(unknown)";
    const worst = safeNum(ch.worst_anomaly, safeNum(ch.worst, NaN));
    const sticky = safeNum(ch.sticky_red, safeNum(ch.sticky, 0));
    div.innerHTML = `
      <div class="t">${escapeHtml(title)}</div>
      <div class="m">worst: ${Number.isFinite(worst) ? worst.toFixed(2) : "?"} / sticky_red: ${sticky}</div>
    `;
    div.addEventListener("click", () => {
      if (ch.channel_id) setChannel(ch.channel_id);
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
    opt.value = ch.channel_id || "";
    const title = ch.title || ch.handle || ch.channel_id || "(unknown)";
    const sticky = safeNum(ch.sticky_red, safeNum(ch.sticky, 0));
    opt.textContent = `${title}  (sticky_red=${sticky})`;
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
    // 既にロード済みなら即再描画
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

  const title = bundle?.channel?.title || bundle?.channel?.handle || state.currentChannelId || "(unknown)";
  $("#baselineInfo").textContent =
    `Channel: ${title} / baseline: a=${Number.isFinite(a) ? a.toFixed(3) : "?"}, b=${Number.isFinite(bb) ? bb.toFixed(3) : "?"}` +
    ` / upper_ratio_ref=${Number.isFinite(upper) ? upper.toFixed(2) : "?"}` +
    ` / med_like_rate=${Number.isFinite(medLike) ? medLike.toExponential(2) : "?"}`;
}

/**
 * latest_points.json 想定（例）:
 * [
 *   {
 *     "videoId":"...",
 *     "title":"...",
 *     "publishedAt":"2026-01-01T...",
 *     "days":12.3,
 *     "views":12345,
 *     "likes":456,
 *     "ratio_nat":1.23,
 *     "ratio_like":0.98,
 *     "anomaly_ratio":1.23,
 *     "label":"YELLOW"|"ORANGE"|"RED"|"NORMAL"
 *   }
 * ]
 */
function drawPlot(bundle) {
  const points = Array.isArray(bundle?.points) ? bundle.points : [];
  const baseline = bundle?.latest?.baseline || {};
  const a = safeNum(baseline.a, NaN);
  const b = safeNum(baseline.b, NaN);
  const upperRatio = safeNum(baseline.upper_ratio_ref, NaN);
  const medLikeRate = safeNum(baseline.med_like_rate, NaN);

  // フィルタ: days<=0 や views<=0 は log に載らないので除外（ただし hover表示も崩れるため）
  const rows = points.filter(p => safeNum(p.views, 0) > 0 && safeNum(p.days, 0) > 0);

  const x = [];
  const y = [];
  const hover = [];
  const custom = [];

  for (const p of rows) {
    const videoId = p.videoId || p.video_id || p.id || "";
    const title = p.title || "(no title)";
    const days = safeNum(p.days, NaN);
    const views = safeNum(p.views, NaN);
    const likes = safeNum(p.likes, NaN);

    const ratioNat = safeNum(p.ratio_nat, safeNum(p.ratioNat, NaN));
    const ratioLike = safeNum(p.ratio_like, safeNum(p.ratioLike, NaN));
    const anomaly = safeNum(p.anomaly_ratio, safeNum(p.anomaly, NaN));
    const label = (p.label || p.level || "NORMAL").toUpperCase();

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
      `views: ${fmtInt(views)}`,
      `likes: ${Number.isFinite(likes) ? fmtInt(likes) : "?"}`,
      `ratio_nat: ${Number.isFinite(ratioNat) ? ratioNat.toFixed(2) : "?"}`,
      `ratio_like: ${Number.isFinite(ratioLike) ? ratioLike.toFixed(2) : "?"}`,
      `anomaly_ratio: ${Number.isFinite(anomaly) ? anomaly.toFixed(2) : "?"}`,
      `<a href="${url}" target="_blank" rel="noreferrer">open</a>`
    ].join("<br>");

    hover.push(h);
    custom.push({ label });
  }

  // 点（散布）
  const scatter = {
    type: "scattergl",
    mode: "markers",
    name: "videos",
    x,
    y,
    text: hover,
    hoverinfo: "text",
    marker: {
      size: 6,
      opacity: 0.85,
    },
  };

  // 期待線・上限線
  const lines = buildBaselineTraces(state.mode, rows, { a, b, upperRatio, medLikeRate });

  const layout = {
    margin: { l: 60, r: 20, t: 40, b: 60 },
    paper_bgcolor: "rgba(0,0,0,0)",
    plot_bgcolor: "rgba(0,0,0,0)",
    hoverlabel: { bordercolor: "rgba(255,255,255,0.2)" },
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

  const config = {
    displayModeBar: true,
    responsive: true,
  };

  Plotly.newPlot("plot", [scatter, ...lines], layout, config);
}

function buildBaselineTraces(mode, rows, { a, b, upperRatio, medLikeRate }) {
  // x軸範囲を rows から推定
  if (!rows.length) return [];

  // log軸なので、min/max を正の値で拾う
  const daysArr = rows.map(p => safeNum(p.days, NaN)).filter(v => v > 0);
  const viewsArr = rows.map(p => safeNum(p.views, NaN)).filter(v => v > 0);
  const likesArr = rows.map(p => safeNum(p.likes, NaN)).filter(v => v > 0);

  // 線を描くサンプル点数
  const N = 80;

  if (mode === "views_likes") {
    if (!viewsArr.length || !(medLikeRate > 0)) return [];

    const xmin = Math.min(...viewsArr);
    const xmax = Math.max(...viewsArr);
    const xs = logspace(xmin, xmax, N);

    const ys = xs.map(v => v * medLikeRate);
    const traces = [
      {
        type: "scatter",
        mode: "lines",
        name: "expected",
        x: xs,
        y: ys,
        hoverinfo: "skip",
        line: { width: 2, dash: "solid" },
      }
    ];

    if (upperRatio > 0) {
      traces.push({
        type: "scatter",
        mode: "lines",
        name: "upper",
        x: xs,
        y: ys.map(v => v * upperRatio),
        hoverinfo: "skip",
        line: { width: 2, dash: "dot" },
      });
    }
    return traces;
  }

  // views_days
  if (!daysArr.length || !(Number.isFinite(a) && Number.isFinite(b))) return [];

  const xmin = Math.min(...daysArr);
  const xmax = Math.max(...daysArr);
  const xs = logspace(xmin, xmax, N);

  const pred = xs.map(d => {
    const ld = Math.log10(d);
    const lv = a + b * ld;
    return Math.pow(10, lv);
  });

  const traces = [
    {
      type: "scatter",
      mode: "lines",
      name: "expected",
      x: xs,
      y: pred,
      hoverinfo: "skip",
      line: { width: 2, dash: "solid" },
    }
  ];

  if (upperRatio > 0) {
    traces.push({
      type: "scatter",
      mode: "lines",
      name: "upper",
      x: xs,
      y: pred.map(v => v * upperRatio),
      hoverinfo: "skip",
      line: { width: 2, dash: "dot" },
    });
  }

  return traces;
}

function logspace(xmin, xmax, n) {
  const lo = Math.log10(xmin);
  const hi = Math.log10(xmax);
  const arr = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const v = Math.pow(10, lo + (hi - lo) * t);
    arr.push(v);
  }
  return arr;
}

function renderRedList(bundle) {
  const root = $("#redList");
  root.innerHTML = "";

  const st = bundle?.state || {};
  const redTop = Array.isArray(st.red_top) ? st.red_top : (Array.isArray(st.redTop) ? st.redTop : []);
  const points = Array.isArray(bundle?.points) ? bundle.points : [];

  // red_top が videoId 群だけの場合に備えて join
  const lookup = new Map();
  for (const p of points) {
    const id = p.videoId || p.video_id || p.id;
    if (id) lookup.set(id, p);
  }

  const list = redTop.slice(0, 10).map((x) => {
    if (typeof x === "string") return lookup.get(x) || { videoId: x };
    if (x && typeof x === "object") {
      const id = x.videoId || x.video_id || x.id;
      return lookup.get(id) || x;
    }
    return null;
  }).filter(Boolean);

  if (!list.length) {
    root.innerHTML = `<div class="item"><div class="m">RED上位がありません</div></div>`;
    return;
  }

  for (const p of list) {
    const id = p.videoId || p.video_id || p.id || "";
    const title = p.title || "(no title)";
    const anomaly = safeNum(p.anomaly_ratio, safeNum(p.anomaly, NaN));
    const views = safeNum(p.views, NaN);
    const likes = safeNum(p.likes, NaN);
    const url = youtubeUrl(id);

    const div = document.createElement("div");
    div.className = "item";
    div.innerHTML = `
      <div class="t"><a href="${url}" target="_blank" rel="noreferrer">${escapeHtml(title)}</a></div>
      <div class="m">anomaly_ratio: ${Number.isFinite(anomaly) ? anomaly.toFixed(2) : "?"} / views: ${fmtInt(views)} / likes: ${Number.isFinite(likes) ? fmtInt(likes) : "?"}</div>
    `;
    root.appendChild(div);
  }
}

/* 既存の「ドクドク」を壊さないため、最低限のサンプル実装。
   すでに app.js 内に実装があるなら、ここを既存に差し替えてOK。
*/
let dokudokuTimer = null;
function startDokudoku(bundle) {
  const canvas = $("#dokudoku");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");

  // 対象: RED上位10件
  const st = bundle?.state || {};
  const redTop = Array.isArray(st.red_top) ? st.red_top : [];
  const points = Array.isArray(bundle?.points) ? bundle.points : [];
  const lookup = new Map(points.map(p => [p.videoId || p.video_id || p.id, p]));
  const list = redTop.slice(0, 10).map(x => lookup.get(x) || x).filter(Boolean);

  if (dokudokuTimer) clearInterval(dokudokuTimer);

  let t = 0;
  dokudokuTimer = setInterval(() => {
    t += 1;

    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    // 背景
    ctx.fillStyle = "rgba(0,0,0,0.25)";
    ctx.fillRect(0, 0, w, h);

    // 心拍っぽい拡縮
    const beat = 0.5 + 0.5 * Math.sin(t * 0.22) * Math.sin(t * 0.07);
    const rBase = 40 + beat * 25;

    // 丸を複数描いて「ドクドク」演出
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

    // REDタイトル
    ctx.fillStyle = "rgba(255,255,255,0.9)";
    ctx.font = "12px ui-sans-serif, system-ui";
    ctx.fillText("RED top10", 12, 22);

    // リスト描画（短く）
    ctx.fillStyle = "rgba(255,255,255,0.75)";
    ctx.font = "11px ui-sans-serif, system-ui";
    list.slice(0, 6).forEach((p, idx) => {
      const title = (p.title || "(no title)").slice(0, 22);
      const a = safeNum(p.anomaly_ratio, NaN);
      ctx.fillText(`${idx + 1}. ${title}  ${Number.isFinite(a) ? a.toFixed(2) : "?"}`, 12, 44 + idx * 18);
    });
  }, 50);
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

async function boot() {
  // mode buttons
  $("#btnViewsDays").addEventListener("click", () => setMode("views_days"));
  $("#btnViewsLikes").addEventListener("click", () => setMode("views_likes"));

  // index
  const index = await fetchJson(`${DATA_BASE}/index.json`);
  state.index = index;

  renderChannelList(index);
  renderChannelSelect(index);

  // 初期チャンネル
  const first = Array.isArray(index?.channels) ? index.channels[0] : null;
  const channelId = first?.channel_id || first?.channelId || null;
  if (channelId) {
    await setChannel(channelId);
  } else {
    // 空のプロット
    Plotly.newPlot("plot", [], { title: "no channel" }, { responsive: true });
  }
}

boot().catch((e) => {
  console.error(e);
  const el = $("#baselineInfo");
  if (el) el.textContent = `boot error: ${e?.message || e}`;
});
