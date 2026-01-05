#!/usr/bin/env python3
import os, json, time, math, argparse
from datetime import datetime, timezone
from pathlib import Path

import requests
import numpy as np
import pandas as pd
import statsmodels.formula.api as smf

# ============================
# JSONサニタイズ（重要）
# - json.dumps はデフォルトで NaN/Infinity を出力してしまい、ブラウザが JSON.parse できず壊れる
# - NaN/Inf を None(null) に落とし、allow_nan=False で混入時に即エラーにする
# ============================
def _json_sanitize(x):
    if isinstance(x, float):
        if math.isnan(x) or math.isinf(x):
            return None
        return x
    if isinstance(x, dict):
        return {k: _json_sanitize(v) for k, v in x.items()}
    if isinstance(x, (list, tuple)):
        return [_json_sanitize(v) for v in x]
    return x

def dumps_json(obj, *, indent=2):
    return json.dumps(_json_sanitize(obj), ensure_ascii=False, indent=indent, allow_nan=False)

def dumps_jsonl(obj):
    return json.dumps(_json_sanitize(obj), ensure_ascii=False, allow_nan=False)

# ============================
# make_plots.py のパラメータ（完全一致）
# ============================
NAT_QUANTILE = 0.6
NAT_UPPER_RATIO = 3.0
NAT_BIG_RATIO = 10.0

LIKES_SUSPECT_RATIO = 3.0
LIKES_BIG_RATIO = 10.0

RECENT_DAYS_EXCLUDE = 7
NAT_BUZZ_TOP_PCT = 95
LIKES_GOOD_VIEWS_MIN = 100
LIKES_MID_VIEWS_PCT = 80

# ============================
# オンデマンド自動追加の追加条件（確定）
# ============================
AUTO_WATCH_MIN_LATEST_COUNT = 50
AUTO_WATCH_MIN_CHANNEL_AGE_DAYS = 180

# ============================
# 運用パラメータ
# ============================
MAX_VIDEOS = 500
RED_TRACK_MAX = 100

# ★ショートは likes 側評価から除外
EXCLUDE_SHORTS = True

YT_API_KEY = os.environ.get("YT_API_KEY", "").strip()

BASE_DIR = Path(__file__).resolve().parents[1]
DATA_DIR = BASE_DIR / "data"
SITE_DATA_DIR = BASE_DIR / "site" / "data"
WATCHLIST = DATA_DIR / "watchlist.txt"
WATCHLIST_AUTO = DATA_DIR / "watchlist_auto.txt"

# ★長めショート判定のためのHTTPセッション/キャッシュ
_SHORTS_URL_CACHE = {}  # video_id -> bool
_HTTP = requests.Session()
_HTTP.headers.update({
    "User-Agent": "yt-anomaly-monitor/shorts-detector",
})


def yt_get(url, params):
    r = requests.get(url, params=params, timeout=30)
    r.raise_for_status()
    return r.json()


def iso8601_duration_to_seconds(s):
    if not s or not s.startswith("PT"):
        return 0
    s = s[2:]
    total = 0
    num = ""
    for ch in s:
        if ch.isdigit():
            num += ch
            continue
        if not num:
            continue
        v = int(num)
        num = ""
        if ch == "H":
            total += v * 3600
        elif ch == "M":
            total += v * 60
        elif ch == "S":
            total += v
    return total


def is_short_by_shorts_url(video_id: str) -> bool:
    """
    ★YouTube Data APIには「Shortsかどうか」の確実なフラグがないため、
      /shorts/<id> にアクセスした際の最終URLで判定する。
      - Shortsの場合: 最終URLが .../shorts/<id> のまま
      - 非Shortsの場合: .../watch?v=<id> にリダイレクトされることが多い
    """
    vid = (video_id or "").strip()
    if not vid:
        return False
    if vid in _SHORTS_URL_CACHE:
        return _SHORTS_URL_CACHE[vid]

    url = f"https://www.youtube.com/shorts/{vid}"
    ok = False
    try:
        r = _HTTP.get(url, allow_redirects=True, timeout=10)
        final = (r.url or "")
        ok = (f"/shorts/{vid}" in final)
        time.sleep(0.05)
    except Exception:
        ok = False

    _SHORTS_URL_CACHE[vid] = ok
    return ok


def resolve_channel_id(watch_key):
    key = (watch_key or "").strip()
    if not key:
        raise ValueError("empty watch_key")
    if key.startswith("UC"):
        return key

    handle = key[1:] if key.startswith("@") else key

    url = "https://www.googleapis.com/youtube/v3/channels"
    params = {"part": "id", "forHandle": handle, "key": YT_API_KEY}
    js = yt_get(url, params)
    items = js.get("items", [])
    if not items:
        raise RuntimeError(f"handle not found: {watch_key}")
    return items[0].get("id")


def fetch_channel(channel_id):
    url = "https://www.googleapis.com/youtube/v3/channels"
    params = {"part": "snippet,contentDetails", "id": channel_id, "key": YT_API_KEY}
    js = yt_get(url, params)
    items = js.get("items", [])
    if not items:
        raise RuntimeError(f"channel not found: {channel_id}")
    return items[0]


def fetch_latest_playlist_items(playlist_id, max_results=500):
    url = "https://www.googleapis.com/youtube/v3/playlistItems"
    out = {"items": []}

    page_token = None
    remain = int(max_results)

    while remain > 0:
        n = min(50, remain)
        params = {
            "part": "contentDetails",
            "playlistId": playlist_id,
            "maxResults": n,
            "pageToken": page_token or "",
            "key": YT_API_KEY,
        }
        js = yt_get(url, params)
        out["items"].extend(js.get("items", []))
        page_token = js.get("nextPageToken")
        remain -= n
        if not page_token:
            break
        time.sleep(0.05)

    return out


def chunked(xs, n):
    buf = []
    for x in xs:
        buf.append(x)
        if len(buf) >= n:
            yield buf
            buf = []
    if buf:
        yield buf


def fetch_videos(video_ids):
    url = "https://www.googleapis.com/youtube/v3/videos"
    videos = []
    for ch in chunked(video_ids, 50):
        params = {
            "part": "snippet,statistics,contentDetails",
            "id": ",".join(ch),
            "maxResults": 50,
            "key": YT_API_KEY,
        }
        js = yt_get(url, params)
        videos.extend(js.get("items", []))
        time.sleep(0.05)
    return videos


def ensure_dir(p: Path):
    p.mkdir(parents=True, exist_ok=True)


def now_utc():
    return datetime.now(timezone.utc)


def copy_tree(src: Path, dst: Path):
    ensure_dir(dst)
    for path in src.rglob("*"):
        rel = path.relative_to(src)
        target = dst / rel
        if path.is_dir():
            ensure_dir(target)
        else:
            ensure_dir(target.parent)
            target.write_bytes(path.read_bytes())


def read_watchlist():
    ensure_dir(DATA_DIR)
    if not WATCHLIST.exists():
        WATCHLIST.write_text("", encoding="utf-8")
    ls = [ln.strip() for ln in WATCHLIST.read_text(encoding="utf-8").splitlines()]
    return [ln for ln in ls if ln and not ln.startswith("#")]


def compute_points_and_baseline(videos, run_at):
    rows = []
    for v in videos:
        vid = v.get("id")
        sn = v.get("snippet", {})
        st = v.get("statistics", {})
        cd = v.get("contentDetails", {})

        if not vid:
            continue

        pub_s = sn.get("publishedAt")
        if not pub_s:
            continue
        pub = datetime.fromisoformat(pub_s.replace("Z", "+00:00"))

        t_days = (run_at - pub).total_seconds() / (3600 * 24)
        t_days = max(float(t_days), 1.0)

        viewCount = int(st.get("viewCount", 0) or 0)
        likeCount = int(st.get("likeCount", 0) or 0)

        durationSec = iso8601_duration_to_seconds(cd.get("duration", ""))

        # ★修正1：durationSec==0（durationが取れてない）を Short 扱いにしない
        # ★修正2：60秒超でも「/shorts/」判定で拾う
        isShort = ((durationSec > 0 and durationSec <= 60) or is_short_by_shorts_url(vid))

        rows.append(
            {
                "video_id": vid,
                "title": sn.get("title", ""),
                "publishedAt": pub_s,
                "days": t_days,
                "views": viewCount,
                "likes": likeCount,
                "durationSec": int(durationSec),
                "isShort": bool(isShort),
            }
        )

    df_all = pd.DataFrame(rows)
    if df_all.empty:
        return [], {
            "nat_quantile": NAT_QUANTILE,
            "a_days": float("nan"),
            "b_days": float("nan"),
            "NAT_UPPER_RATIO": NAT_UPPER_RATIO,
            "NAT_BIG_RATIO": NAT_BIG_RATIO,
            "b0": float("nan"),
            "b1": float("nan"),
            "LIKES_SUSPECT_RATIO": LIKES_SUSPECT_RATIO,
            "LIKES_BIG_RATIO": LIKES_BIG_RATIO,
            "fit_mask": {},
        }

    # ----------------------------
    # NAT（再生×日数）側：ショートも含めてOK（解析上は）
    # ----------------------------
    df_nat = df_all.copy()
    df_nat["logv"] = np.log(np.clip(df_nat["views"].astype(float), 1.0, None))

    df_fit = df_nat.copy()
    if RECENT_DAYS_EXCLUDE and RECENT_DAYS_EXCLUDE > 0:
        df_fit = df_fit[df_fit["days"] >= float(RECENT_DAYS_EXCLUDE)].copy()

    if not df_fit.empty and NAT_BUZZ_TOP_PCT and 0 < NAT_BUZZ_TOP_PCT < 100:
        vcut = np.percentile(df_fit["views"].astype(float), NAT_BUZZ_TOP_PCT)
        df_fit = df_fit[df_fit["views"].astype(float) <= float(vcut)].copy()

    if df_fit.empty:
        a_days = float("nan")
        b_days = float("nan")
    else:
        model = smf.quantreg("logv ~ days", df_fit)
        res = model.fit(q=NAT_QUANTILE)
        a_days = float(res.params.get("Intercept", float("nan")))
        b_days = float(res.params.get("days", float("nan")))

    t = df_nat["days"].astype(float).to_numpy()
    logv_center_all = a_days + b_days * t
    v_expected = np.exp(logv_center_all)
    ratio_nat = df_nat["views"].astype(float).to_numpy() / np.clip(v_expected, 1.0, None)

    nat_level = np.array(["OK"] * len(df_nat), dtype=object)
    nat_level[(ratio_nat >= NAT_UPPER_RATIO) & (ratio_nat < NAT_BIG_RATIO)] = "△"
    nat_level[ratio_nat >= NAT_BIG_RATIO] = "RED"

    # ----------------------------
    # LIKES（再生×高評価）側：ショートは除外してフィット/判定
    # ----------------------------
    if EXCLUDE_SHORTS and "isShort" in df_all.columns:
        df_like_base = df_all[~df_all["isShort"]].copy()
    else:
        df_like_base = df_all.copy()

    df2 = df_like_base.copy()
    df2 = df2[df2["likes"].astype(float) >= 1.0].copy()
    df2 = df2[df2["views"].astype(float) >= float(LIKES_GOOD_VIEWS_MIN)].copy()

    if not df2.empty and LIKES_MID_VIEWS_PCT and 0 < LIKES_MID_VIEWS_PCT < 100:
        vcut2 = np.percentile(df2["views"].astype(float), LIKES_MID_VIEWS_PCT)
        df2 = df2[df2["views"].astype(float) <= float(vcut2)].copy()

    if df2.empty:
        like_b0 = float("nan")
        like_b1 = float("nan")
    else:
        logL = np.log(df2["likes"].astype(float).to_numpy())
        logV = np.log(np.clip(df2["views"].astype(float).to_numpy(), 1.0, None))
        A2 = np.vstack([logL, np.ones_like(logL)]).T
        b1, b0 = np.linalg.lstsq(A2, logV, rcond=None)[0]
        like_b0 = float(b0)
        like_b1 = float(b1)

    ratio_like = np.full(len(df_all), np.nan, dtype=float)
    like_level = np.array(["NA"] * len(df_all), dtype=object)

    if not (math.isnan(like_b0) or math.isnan(like_b1)):
        likes_all = np.clip(df_all["likes"].astype(float).to_numpy(), 1.0, None)
        logL_all = np.log(likes_all)
        logV_expected = like_b0 + like_b1 * logL_all
        v_expected_like = np.exp(logV_expected)
        ratio_like_all = df_all["views"].astype(float).to_numpy() / np.clip(v_expected_like, 1.0, None)

        if EXCLUDE_SHORTS and "isShort" in df_all.columns:
            mask = ~df_all["isShort"].to_numpy(dtype=bool)
        else:
            mask = np.ones(len(df_all), dtype=bool)

        ratio_like[mask] = ratio_like_all[mask]

        like_level[:] = "OK"
        like_level[(ratio_like >= LIKES_SUSPECT_RATIO) & (ratio_like < LIKES_BIG_RATIO)] = "△"
        like_level[ratio_like >= LIKES_BIG_RATIO] = "RED"
        if EXCLUDE_SHORTS and "isShort" in df_all.columns:
            like_level[df_all["isShort"].to_numpy(dtype=bool)] = "NA"

    # ----------------------------
    # points 出力（durationSec/isShort を含める）
    # ----------------------------
    points = []
    df_out = df_all.reset_index(drop=True)

    for i, r in df_out.iterrows():
        p = {
            "video_id": r["video_id"],
            "title": r["title"],
            "publishedAt": r["publishedAt"],
            "days": float(r["days"]),
            "views": int(r["views"]),
            "likes": int(r["likes"]),
            "ratio_nat": float(ratio_nat[i]),
            "ratio_like": (float(ratio_like[i]) if np.isfinite(ratio_like[i]) else float("nan")),
            "nat_level": str(nat_level[i]),
            "like_level": str(like_level[i]),
            "durationSec": int(r.get("durationSec", 0)),
            "isShort": bool(r.get("isShort", False)),
        }

        if p["nat_level"] == "RED" or p["like_level"] == "RED":
            p["display_label"] = "RED"
        elif p["nat_level"] == "△" or p["like_level"] == "△":
            p["display_label"] = "△"
        else:
            p["display_label"] = "OK"

        rr_like = p["ratio_like"]
        if isinstance(rr_like, float) and math.isnan(rr_like):
            p["anomaly_ratio"] = float(p["ratio_nat"])
        else:
            p["anomaly_ratio"] = float(max(p["ratio_nat"], rr_like))

        points.append(p)

    baseline = {
        "nat_quantile": NAT_QUANTILE,
        "a_days": a_days,
        "b_days": b_days,
        "NAT_UPPER_RATIO": NAT_UPPER_RATIO,
        "NAT_BIG_RATIO": NAT_BIG_RATIO,
        "b0": like_b0,
        "b1": like_b1,
        "LIKES_SUSPECT_RATIO": LIKES_SUSPECT_RATIO,
        "LIKES_BIG_RATIO": LIKES_BIG_RATIO,
        "fit_mask": {
            "RECENT_DAYS_EXCLUDE": RECENT_DAYS_EXCLUDE,
            "NAT_BUZZ_TOP_PCT": NAT_BUZZ_TOP_PCT,
            "likes_good_views_min": LIKES_GOOD_VIEWS_MIN,
            "likes_mid_views_pct": LIKES_MID_VIEWS_PCT,
            "EXCLUDE_SHORTS_LIKES": bool(EXCLUDE_SHORTS),
        },
    }

    return points, baseline


def update_state_and_red(points, state_path: Path):
    sticky = set()
    if state_path.exists():
        try:
            old = json.loads(state_path.read_text(encoding="utf-8"))
            for vid in old.get("sticky_red", []):
                if vid:
                    sticky.add(vid)
        except Exception:
            pass

    for p in points:
        if p.get("display_label") == "RED":
            sticky.add(p["video_id"])
            p["sticky_red"] = True

    for p in points:
        if p["video_id"] in sticky:
            p["sticky_red"] = True

    reds = [p for p in points if p.get("sticky_red") or p.get("display_label") == "RED"]
    reds.sort(key=lambda x: x.get("anomaly_ratio", 0.0), reverse=True)
    red_top = [p["video_id"] for p in reds[:RED_TRACK_MAX]]

    state_obj = {"sticky_red": sorted(list(sticky)), "red_top": red_top}
    state_path.write_text(dumps_json(state_obj), encoding="utf-8")
    return state_obj


def append_watchlist_channel_id(channel_id: str) -> bool:
    channel_id = (channel_id or "").strip()
    if not channel_id:
        return False

    ensure_dir(DATA_DIR)
    if not WATCHLIST.exists():
        WATCHLIST.write_text("", encoding="utf-8")

    existing = [ln.strip() for ln in WATCHLIST.read_text(encoding="utf-8").splitlines()]
    existing = [ln for ln in existing if ln and not ln.startswith("#")]

    if channel_id in existing:
        return False

    with WATCHLIST.open("a", encoding="utf-8") as f:
        txt = WATCHLIST.read_text(encoding="utf-8")
        if txt and not txt.endswith("\n"):
            f.write("\n")
        f.write(channel_id + "\n")
    return True


def parse_args():
    p = argparse.ArgumentParser(description="Weekly (or on-demand) YouTube anomaly monitor data generator")
    p.add_argument("--channel", default="", help="Process only this channel too (@handle or UC... channelId).")
    p.add_argument("--auto_watch_red_top", type=int, default=0, help="Auto append watchlist when red_top_count >= this.")
    return p.parse_args()


def main():
    args = parse_args()

    if not YT_API_KEY:
        raise SystemExit("YT_API_KEY is required.")

    run_at = now_utc()
    run_at_utc = run_at.isoformat()

    ensure_dir(DATA_DIR / "channels")

    watch = read_watchlist()

    extra = (args.channel or "").strip()
    if extra:
        watch_run = [extra] + [w for w in watch if w != extra]
    else:
        watch_run = list(watch)

    channels_index = []
    warnings = []

    for watch_key in watch_run:
        try:
            cid = resolve_channel_id(watch_key)
            ch = fetch_channel(cid)

            title = ch.get("snippet", {}).get("title", "")
            uploads = ch.get("contentDetails", {}).get("relatedPlaylists", {}).get("uploads")
            if not uploads:
                raise RuntimeError("uploads playlist not found")

            ch_dir = DATA_DIR / "channels" / cid
            ensure_dir(ch_dir)

            (ch_dir / "channel.json").write_text(
                dumps_json(ch),
                encoding="utf-8",
            )

            pli = fetch_latest_playlist_items(uploads, MAX_VIDEOS)
            (ch_dir / "latest_500_playlistItems.json").write_text(
                dumps_json(pli),
                encoding="utf-8",
            )

            video_ids = []
            for it in pli.get("items", []):
                vid = it.get("contentDetails", {}).get("videoId")
                if vid:
                    video_ids.append(vid)

            videos = fetch_videos(video_ids)

            points, baseline = compute_points_and_baseline(videos, run_at)

            (ch_dir / "latest_points.json").write_text(
                dumps_json({"run_at_utc": run_at_utc, "points": points}),
                encoding="utf-8",
            )

            latest = {"run_at_utc": run_at_utc, "baseline": baseline}

            with (ch_dir / "runs.jsonl").open("a", encoding="utf-8") as f:
                f.write(dumps_jsonl(latest) + "\n")

            st = update_state_and_red(points, ch_dir / "state.json")
            (ch_dir / "latest.json").write_text(
                dumps_json(latest),
                encoding="utf-8",
            )

            max_anom = max((p.get("anomaly_ratio", 0.0) for p in points), default=0.0)

            if args.auto_watch_red_top and int(args.auto_watch_red_top) > 0:
                red_top_count = len(st.get("red_top", []))
                latest_count = len(points)
                channel_age_days = 0
                if points:
                    channel_age_days = max(p.get("days", 0) for p in points)

                if (
                    red_top_count >= int(args.auto_watch_red_top)
                    and latest_count >= AUTO_WATCH_MIN_LATEST_COUNT
                    and channel_age_days >= AUTO_WATCH_MIN_CHANNEL_AGE_DAYS
                ):
                    appended = append_watchlist_channel_id(cid)
                    if appended:
                        print("[ondemand] appended to watchlist:", cid)
                else:
                    print("[ondemand] NOT appended:", cid)

            channels_index.append(
                {
                    "channel_id": cid,
                    "watch_key": watch_key,
                    "title": title,
                    "sticky_red_count": len(st.get("sticky_red", [])),
                    "red_top_count": len(st.get("red_top", [])),
                    "max_anomaly_ratio": float(max_anom),
                }
            )

        except Exception as e:
            warnings.append({"watch_key": watch_key, "error": str(e)})

    channels_index.sort(key=lambda x: x.get("max_anomaly_ratio", 0.0), reverse=True)

    index_obj = {
        "generated_at_utc": run_at_utc,
        "watch_count": len(watch_run),
        "warnings": warnings,
        "channels": channels_index,
    }
    (DATA_DIR / "index.json").write_text(dumps_json(index_obj), encoding="utf-8")

    auto = [ch["channel_id"] for ch in channels_index if ch.get("sticky_red_count", 0) >= 3]
    WATCHLIST_AUTO.write_text("\n".join(auto) + ("\n" if auto else ""), encoding="utf-8")

    ensure_dir(SITE_DATA_DIR)
    copy_tree(DATA_DIR, SITE_DATA_DIR)

    print("weekly done.")
    if warnings:
        print("warnings:", warnings)


if __name__ == "__main__":
    main()
