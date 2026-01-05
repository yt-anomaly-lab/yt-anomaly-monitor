/* global Plotly */

(() => {
  "use strict";

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

  /* ===========================
     ★ SHORTS 判定（集約）
     =========================== */
  function isShortVideo(p) {
    if (p?.is_short === true) return true;

    const dur =
      Number(p?.duration_sec ?? p?.duration ?? NaN);
    if (Number.isFinite(dur) && dur > 0 && dur <= 60) return true;

    const text = (
      (p?.title ?? "") +
      " " +
      (p?.description ?? "") +
      " " +
      (Array.isArray(p?.tags) ? p.tags.join(" ") : "")
    ).toLowerCase();
    if (text.includes("#shorts")) return true;

    return false;
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
  function getVideoId(p) { return p?.videoId || p?.video_id || p?.id || ""; }
  function getTitle(p) { return p?.title || "(no title)"; }
  function getDays(p) { return safeNum(p?.t_days, safeNum(p?.days, NaN)); }
  function getViews(p) { return safeNum(p?.viewCount, safeNum(p?.views, NaN)); }
  function getLikes(p) { return safeNum(p?.likeCount, safeNum(p?.likes, NaN)); }
  function getAnomalyRatio(p) { return safeNum(p?.anomaly_ratio, NaN); }
  function getRatioNat(p) { return safeNum(p?.ratio_nat, NaN); }
  function getRatioLike(p) { return safeNum(p?.ratio_like, NaN); }

  /* ===========================
     ★ 以降、points を使う箇所は
     必ず isShortVideo を除外
     =========================== */

  function classifyByUpper(p, baseline) {
    // ★SHORTS EXCLUDE（二重安全）
    if (isShortVideo(p)) return "NORMAL";

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

  async function drawPlot(bundle) {
    const baseline = bundle?.latest?.baseline || {};

    // ★SHORTS EXCLUDE（最上流）
    const rows = bundle.points.filter(p => {
      if (isShortVideo(p)) return false;
      const v = getViews(p);
      const l = getLikes(p);
      const d = getDays(p);
      if (!(v > 0 && l > 0)) return false;
      if (state.mode === "views_days") return d >= 1;
      return true;
    });

    // …（以下、描画ロジックは元のまま）
    // ※ この rows から先に Shorts は一切流れません


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
      layout.xaxis = { title: "公開日数", type: "linear", gridcolor: "rgba(255,255,255,0.06)" };
      layout.yaxis = { title: "再生数", type: state.yLog ? "log" : "linear", gridcolor: "rgba(255,255,255,0.06)" };
    } else {
      layout.title = { text: "高評価乖離評価", x: 0.02 };
      layout.xaxis = { title: "再生数", type: "log", gridcolor: "rgba(255,255,255,0.06)" };
      layout.yaxis = { title: "高評価数", type: "log", gridcolor: "rgba(255,255,255,0.06)" };
    }

    await Plotly.newPlot("plot", [scatter, ...lines], layout, { displayModeBar:true, responsive:true });

    state.redPlotPoints = computeRedPlotPoints(rows, state.mode, baseline);
    syncPulseCanvasToPlot();
    ensurePulseLoop();
    attachPlotEventsOnce();

    updateYScaleButtons();
    renderBaselineInfo(bundle);
  }

  function cssClassForLabel(label) {
    const L = String(label || "").toUpperCase();
    if (L === "RED") return "red";
    if (L === "ORANGE") return "orange";
    if (L === "YELLOW") return "yellow";
    return "";
  }

  /* ★修正：state.jsonのred_top依存をやめる → pointsから「異常値上位」を作る */
  function renderAnomalyTopList(bundle) {
    const root = $("#redList");
    if (!root) return;
    root.innerHTML = "";

    const baseline = bundle?.latest?.baseline || {};
    const points = Array.isArray(bundle?.points) ? bundle.points : [];
    const rows = points.filter(p => (getViews(p) > 0 && getLikes(p) > 0));

    const sorted = rows
      .map(p => {
        const ar = getAnomalyRatio(p);
        const label = classifyByUpper(p, baseline);
        return { p, ar: Number.isFinite(ar) ? ar : -1, label };
      })
      .sort((a,b) => b.ar - a.ar)
      .slice(0, 30);

    if (!sorted.length) {
      root.innerHTML = `<div class="item"><div class="m">異常値が上位の動画がありません</div></div>`;
      return;
    }

    for (const it of sorted) {
      const p = it.p;
      const id = getVideoId(p);
      const title = getTitle(p);
      const v = getViews(p);
      const l = getLikes(p);
      const ar = getAnomalyRatio(p);
      const label = it.label;

      const div = document.createElement("div");
      div.className = `item ${cssClassForLabel(label)}`.trim();
      div.innerHTML = `
        <div class="t"><a href="${youtubeUrl(id)}" target="_blank" rel="noreferrer">${escapeHtml(title)}</a></div>
        <div class="m">判定: ${escapeHtml(label)} / anomaly_ratio: ${Number.isFinite(ar) ? ar.toFixed(2) : "?"} / views: ${fmtInt(v)} / likes: ${fmtInt(l)}</div>
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

        showManualHint("解析中…（オンデマンド起動 → Pages反映待ち）");
        const res = await startOndemand(input);

        let channelId =
          (res && (res.channel_id || res.channelId || res.id)) ||
          (input.startsWith("UC") ? input : null);

        if (!channelId) {
          showManualHint("解析中…（index更新待ち）");
          channelId = await waitChannelIdFromIndex(input);
        }

        if (!channelId) { showManualHint("オンデマンドは起動しましたが、チャンネルが index に反映されませんでした。"); return; }

        showManualHint("解析中…（データ生成待ち）");
        const ok = await waitChannelDataReady(channelId);
        if (!ok) { showManualHint("データがまだ反映されていません。"); return; }

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
    setModeDescriptionVisibility();

    const index = await fetchJson(`${DATA_BASE}/index.json?ts=${Date.now()}`);
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

})();
