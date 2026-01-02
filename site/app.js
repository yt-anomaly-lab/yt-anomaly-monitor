const DATA_BASE = "./data"; // site/ から見た data/（GitHub Pagesデプロイ時に site/data にコピーする方式へ後で変更可）

const el = (id) => document.getElementById(id);
const channelListEl = el("channelList");
const generatedAtEl = el("generatedAt");
const chartTitleEl = el("chartTitle");
const chartSubEl = el("chartSub");

const reloadBtn = el("reloadBtn");
const onlyWatchedChk = el("onlyWatched");
const hideShortChk = el("hideShort");
const logYChk = el("logY");

const plotDiv = el("plot");
const pulseCanvas = el("pulse");
const pulseCtx = pulseCanvas.getContext("2d");

let indexData = null;
let currentChannel = null;
let currentPoints = [];
let pulseTargets = []; // {xPx,yPx,strength,phase}

/** fetch helper */
async function fetchJSON(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`fetch failed: ${res.status} ${url}`);
  return await res.json();
}

function fmt(n) {
  if (n == null) return "-";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
  if (n >= 10_000) return (n / 10_000).toFixed(1) + "万";
  return String(Math.round(n));
}

function yLabel(p) { return logYChk.checked ? "再生数（log）" : "再生数"; }

function isWatched(ch) {
  return (ch.sticky_red_count ?? 0) >= 3;
}

function badgeClass(label) {
  if (label === "RED") return "red";
  if (label === "ORANGE") return "or";
  if (label === "YELLOW") return "yl";
  return "";
}

function renderChannelList() {
  channelListEl.innerHTML = "";
  const chans = (indexData?.channels || []).slice();

  // max_anomaly_ratio 降順（ワーストっぽく）
  chans.sort((a, b) => (b.max_anomaly_ratio || 0) - (a.max_anomaly_ratio || 0));

  for (const ch of chans) {
    if (onlyWatchedChk.checked && !isWatched(ch)) continue;

    const item = document.createElement("div");
    item.className = "item" + (currentChannel?.channel_id === ch.channel_id ? " active" : "");
    item.onclick = () => selectChannel(ch);

    const title = ch.title ? ch.title : ch.channel_id;
    const meta = `
      <span class="badge ${badgeClass("RED")}">sticky赤 ${ch.sticky_red_count ?? 0}</span>
      <span class="badge">赤top ${ch.red_top_count ?? 0}</span>
      <span class="badge">max異常度 ${ (ch.max_anomaly_ratio ?? 0).toFixed(2) }</span>
    `;

    item.innerHTML = `
      <div class="itemTitle">${escapeHtml(title)}</div>
      <div class="itemMeta">${meta}</div>
    `;
    channelListEl.appendChild(item);
  }

  if (!channelListEl.children.length) {
    channelListEl.innerHTML = `<div class="muted">表示対象がありません（sticky赤≧3のチェックを外すか、watchlistを追加してください）</div>`;
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
}

async function loadIndex() {
  indexData = await fetchJSON(`${DATA_BASE}/index.json`);
  generatedAtEl.textContent = `generated: ${indexData.generated_at_utc || "-"}`;
  renderChannelList();

  // まだ選択が無ければ先頭を自動選択
  const first = (indexData.channels || []).find(ch => !onlyWatchedChk.checked || isWatched(ch));
  if (first && !currentChannel) await selectChannel(first);
}

async function selectChannel(ch) {
  currentChannel = ch;
  renderChannelList();

  chartTitleEl.textContent = ch.title ? ch.title : ch.channel_id;
  chartSubEl.textContent = `${ch.channel_id} / sticky赤=${ch.sticky_red_count ?? 0} / max異常度=${(ch.max_anomaly_ratio ?? 0).toFixed(2)}`;

  const url = `${DATA_BASE}/channels/${ch.channel_id}/latest_points.json`;
  const data = await fetchJSON(url);
  currentPoints = data.points || [];

  drawPlot();
}

function filterPoints(points) {
  if (!hideShortChk.checked) return points;
  return points.filter(p => !p.isShort);
}

function colorForLabel(label) {
  // Plotlyの色は固定文字列（ここでは指定）
  if (label === "RED") return "rgba(239,68,68,0.85)";
  if (label === "ORANGE") return "rgba(249,115,22,0.85)";
  if (label === "YELLOW") return "rgba(250,204,21,0.85)";
  return "rgba(148,163,184,0.65)";
}

function drawPlot() {
  const pts = filterPoints(currentPoints);

  const x = pts.map(p => p.days);
  const y = pts.map(p => p.viewCount);

  const colors = pts.map(p => colorForLabel(p.display_label));
  const sizes = pts.map(p => (p.display_label === "RED" ? 10 : p.display_label === "ORANGE" ? 9 : p.display_label === "YELLOW" ? 8 : 7));

  // hover表示（ここが凝りポイント）
  const hover = pts.map(p => {
    const url = `https://www.youtube.com/watch?v=${p.video_id}`;
    return [
      `<b>${escapeHtml(p.title || p.video_id)}</b>`,
      `days: ${p.days.toFixed(1)}`,
      `views: ${fmt(p.viewCount)} / likes: ${fmt(p.likeCount)}`,
      `ratio_nat: ${p.ratio_nat.toFixed(2)} / ratio_like: ${p.ratio_like.toFixed(2)}`,
      `異常度: <b>${p.anomaly_ratio.toFixed(2)}</b>`,
      `label: ${p.display_label}${p.sticky_red ? " (sticky)" : ""}`,
      `<a href="${url}" target="_blank" rel="noopener">open</a>`,
    ].join("<br>");
  });

  const trace = {
    type: "scattergl",
    mode: "markers",
    x,
    y: logYChk.checked ? y.map(v => Math.log10(Math.max(1, v))) : y,
    text: hover,
    hoverinfo: "text",
    marker: {
      size: sizes,
      color: colors,
      line: { width: 0 }
    },
  };

  const layout = {
    margin: { l: 60, r: 20, t: 10, b: 60 },
    paper_bgcolor: "rgba(0,0,0,0)",
    plot_bgcolor: "rgba(0,0,0,0)",
    xaxis: { title: "公開からの日数", gridcolor: "rgba(148,163,184,0.15)", zeroline: false },
    yaxis: { title: yLabel(), gridcolor: "rgba(148,163,184,0.15)", zeroline: false },
    font: { color: "#e6edf3" },
    showlegend: false,
  };

  Plotly.newPlot(plotDiv, [trace], layout, { displayModeBar: true, responsive: true })
    .then(() => {
      syncCanvasSize();
      computePulseTargets(pts);
      requestAnimationFrame(pulseLoop);
    });

  window.addEventListener("resize", () => {
    syncCanvasSize();
    computePulseTargets(filterPoints(currentPoints));
  }, { once: true });
}

function syncCanvasSize() {
  const rect = plotDiv.getBoundingClientRect();
  pulseCanvas.width = Math.floor(rect.width * devicePixelRatio);
  pulseCanvas.height = Math.floor(rect.height * devicePixelRatio);
  pulseCanvas.style.width = rect.width + "px";
  pulseCanvas.style.height = rect.height + "px";
  pulseCtx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
}

function computePulseTargets(pts) {
  // REDだけ、異常度上位Nをドクドク
  const reds = pts.filter(p => p.display_label === "RED");
  reds.sort((a, b) => (b.anomaly_ratio || 0) - (a.anomaly_ratio || 0));
  const top = reds.slice(0, 10);

  // Plotly座標→ピクセル変換
  const gd = plotDiv;
  if (!gd._fullLayout) return;

  const xa = gd._fullLayout.xaxis;
  const ya = gd._fullLayout.yaxis;

  pulseTargets = top.map((p, i) => {
    const xval = p.days;
    const yval = logYChk.checked ? Math.log10(Math.max(1, p.viewCount)) : p.viewCount;
    const xPx = xa.l2p(xval) + gd._fullLayout._size.l;
    const yPx = ya.l2p(yval) + gd._fullLayout._size.t;
    return { xPx, yPx, strength: 1.0 - i * 0.06, phase: Math.random() * Math.PI * 2 };
  });
}

let lastT = 0;
function pulseLoop(t) {
  const dt = (t - lastT) / 1000;
  lastT = t;

  const rect = plotDiv.getBoundingClientRect();
  pulseCtx.clearRect(0, 0, rect.width, rect.height);

  // ドクドク：円が膨らんで薄くなる
  for (const p of pulseTargets) {
    const speed = 2.2; // 心拍っぽい速さ
    p.phase += dt * speed * 2 * Math.PI;

    // パルス波（0..1）
    const wave = Math.max(0, Math.sin(p.phase));
    const r = 6 + 18 * wave * p.strength;
    const alpha = 0.25 * (1 - wave) * p.strength;

    pulseCtx.beginPath();
    pulseCtx.arc(p.xPx, p.yPx, r, 0, Math.PI * 2);
    pulseCtx.strokeStyle = `rgba(239,68,68,${alpha})`;
    pulseCtx.lineWidth = 2;
    pulseCtx.stroke();
  }

  requestAnimationFrame(pulseLoop);
}

reloadBtn.onclick = () => loadIndex().catch(err => alert(err));
onlyWatchedChk.onchange = () => { currentChannel = null; renderChannelList(); loadIndex().catch(console.error); };
hideShortChk.onchange = () => drawPlot();
logYChk.onchange = () => drawPlot();

loadIndex().catch(err => {
  console.error(err);
  alert("data/index.json を読み込めません。Pages配信時は data/ を site/data/ にコピーする運用にします（次の手順で対応します）。");
});
