#!/usr/bin/env python3
import os, json, time, math
from datetime import datetime, timezone
from pathlib import Path

import requests
import numpy as np
import pandas as pd
import statsmodels.formula.api as smf

# ============================
# make_plots.py のパラメータ（完全一致）
# ============================ :contentReference[oaicite:3]{index=3}
NAT_QUANTILE = 0.6
NAT_UPPER_RATIO = 3.0
NAT_BIG_RATIO = 10.0

LIKES_SUSPECT_RATIO = 3.0
LIKES_BIG_RATIO = 10.0

# make_plots.py の fit サンプル選別（完全一致） :contentReference[oaicite:4]{index=4}
RECENT_DAYS_EXCLUDE = 7
NAT_BUZZ_TOP_PCT = 95

# 運用パラメータ
MAX_VIDEOS = 500
RED_TRACK_MAX = 100

EXCLUDE_SHORTS = True  # make_plots.py は isShort 列があれば除外 :contentReference[oaicite:5]{index=5}

YT_API_KEY = os.environ.get("YT_API_KEY", "").strip()

BASE_DIR = Path(__file__).resolve().parents[1]
DATA_DIR = BASE_DIR / "data"
SITE_DATA_DIR = BASE_DIR / "site" / "data"
WATCHLIST = DATA_DIR / "watchlist.txt"
WATCHLIST_AUTO = DATA_DIR / "watchlist_auto.txt"


def yt_get(url, params):
    params = dict(params)
    params["key"] = YT_API_KEY
    r = requests.get(url, params=params, timeout=30)
    r.raise_for_status()
    return r.json()


def iso8601_duration_to_seconds(dur: str) -> int:
    if not dur or not dur.startswith("PT"):
        return 0
    dur = dur[2:]
    n = ""
    total = 0
    for ch in dur:
        if ch.isdigit():
            n += ch
            continue
        if not n:
            continue
        v = int(n)
        n = ""
        if ch == "H":
            total += v * 3600
        elif ch == "M":
            total += v * 60
        elif ch == "S":
            total += v
    return total


def resolve_channel_id(watch_key: str) -> str:
    watch_key = watch_key.strip()
    if watch_key.startswith("UC"):
        return watch_key
    if watch_key.startswith("@"):
        j = yt_get(
            "https://www.googleapis.com/youtube/v3/channels",
            {"part": "id,snippet,contentDetails", "forHandle": watch_key},
        )
        items = j.get("items", [])
        if not items:
            raise RuntimeError(f"handle not found: {watch_key}")
        return items[0]["id"]
    return watch_key


def fetch_channel(channel_id: str) -> dict:
    j = yt_get(
        "https://www.googleapis.com/youtube/v3/channels",
        {"part": "id,snippet,contentDetails,statistics", "id": channel_id},
    )
    items = j.get("items", [])
    if not items:
        raise RuntimeError(f"channel not found: {channel_id}")
    return items[0]


def fetch_latest_playlist_items(uploads_playlist_id: str, max_items=MAX_VIDEOS) -> dict:
    items = []
    page_token = None
    while True:
        j = yt_get(
            "https://www.googleapis.com/youtube/v3/playlistItems",
            {
                "part": "snippet,contentDetails",
                "playlistId": uploads_playlist_id,
                "maxResults": 50,
                **({"pageToken": page_token} if page_token else {}),
            },
        )
        items.extend(j.get("items", []))
        page_token = j.get("nextPageToken")
        if not page_token or len(items) >= max_items:
            break
        time.sleep(0.05)
    return {"items": items[:max_items]}


def chunked(xs, n):
    for i in range(0, len(xs), n):
        yield xs[i : i + n]


def fetch_videos(video_ids):
    out = []
    for ch in chunked(video_ids, 50):
        j = yt_get(
            "https://www.googleapis.com/youtube/v3/videos",
            {"part": "id,snippet,statistics,contentDetails", "id": ",".join(ch), "maxResults": 50},
        )
        out.extend(j.get("items", []))
        time.sleep(0.05)
    return out


def ensure_dir(p: Path):
    p.mkdir(parents=True, exist_ok=True)


def now_utc():
    return datetime.now(timezone.utc)


def copy_tree(src: Path, dst: Path):
    for p in src.rglob("*"):
        rel = p.relative_to(src)
        out = dst / rel
        if p.is_dir():
            out.mkdir(parents=True, exist_ok=True)
        else:
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_bytes(p.read_bytes())


def read_watchlist():
    ensure_dir(DATA_DIR)
    if not WATCHLIST.exists():
        WATCHLIST.write_text("", encoding="utf-8")
    lines = [ln.strip() for ln in WATCHLIST.read_text(encoding="utf-8").splitlines()]
    return [ln for ln in lines if ln and not ln.startswith("#")]


def compute_points_and_baseline(videos, run_at):
    rows = []
    for v in videos:
        vid = v.get("id")
        sn = v.get("snippet", {})
        st = v.get("statistics", {})
        cd = v.get("contentDetails", {})

        publishedAt = sn.get("publishedAt")
        if not publishedAt:
            continue

        pub = datetime.fromisoformat(publishedAt.replace("Z", "+00:00"))
        t_days = (run_at - pub).total_seconds() / (3600 * 24)

        # make_plots.py: clip(lower=1) :contentReference[oaicite:6]{index=6}
        t_days = max(float(t_days), 1.0)

        viewCount = int(st.get("viewCount", 0) or 0)
        likeCount = int(st.get("likeCount", 0) or 0)

        durationSec = iso8601_duration_to_seconds(cd.get("duration", ""))
        isShort = durationSec <= 60

        rows.append(
            {
                "video_id": vid,
                "title": sn.get("title", ""),
                "publishedAt": publishedAt,
                "t_days": t_days,
                "viewCount": viewCount,
                "likeCount": likeCount,
                "durationSec": durationSec,
                "isShort": isShort,
            }
        )

    df = pd.DataFrame(rows)
    if df.empty:
        return [], {}

    # make_plots.py: ショート除外（列があるなら） :contentReference[oaicite:7]{index=7}
    if EXCLUDE_SHORTS and "isShort" in df.columns:
        df = df[df["isShort"] == False]

    # make_plots.py: view/like ゼロ除外 :contentReference[oaicite:8]{index=8}
    df = df[(df["viewCount"] > 0) & (df["likeCount"] > 0)]
    if df.empty:
        return [], {}

    views = df["viewCount"].to_numpy(dtype=float)
    likes = df["likeCount"].to_numpy(dtype=float)
    days = df["t_days"].to_numpy(dtype=float)

    logV = np.log10(views)
    logL = np.log10(likes)

    # ============================
    # A) 自然流入：Quantile Regression
    # log10(Views) = a + b*days
    # fit_mask: t>7 かつ v<95%tile :contentReference[oaicite:9]{index=9}
    # ============================
    t = days.copy()
    v = views.copy()

    mask_not_recent = t > RECENT_DAYS_EXCLUDE
    v95 = np.percentile(v, NAT_BUZZ_TOP_PCT)
    mask_not_top = v < v95
    fit_mask_nat = mask_not_recent & mask_not_top

    # safety fallback（元コードは想定上十分ある前提だが、ゼロ割回避）
    if fit_mask_nat.sum() < 5:
        fit_mask_nat = np.ones_like(t, dtype=bool)

    df_fit = pd.DataFrame({"days": t[fit_mask_nat], "logv": np.log10(v[fit_mask_nat])})
    model = smf.quantreg("logv ~ days", df_fit)
    res = model.fit(q=NAT_QUANTILE) 


    a_days = float(res.params["Intercept"])
    b_days = float(res.params["days"])

    # 中心値（全点）
    logv_center_all = a_days + b_days * t
    v_center_all = np.power(10.0, logv_center_all)
    ratio_nat = v / (v_center_all + 1e-9)

    nat_level = np.full(len(df), "", dtype=object)
    nat_level[ratio_nat >= NAT_BIG_RATIO] = "X"
    nat_level[(ratio_nat >= NAT_UPPER_RATIO) & (ratio_nat < NAT_BIG_RATIO)] = "△"

    # ============================
    # B) 高評価→再生：logL → logV OLS
    # fit_mask: views>=100 かつ views<80%tile :contentReference[oaicite:10]{index=10}
    # ratio_like = views / V_expected(likes)（右ズレ） :contentReference[oaicite:11]{index=11}
    # ============================
    good_mask = views >= 100
    v80_likes = np.percentile(views, 80)
    mid_mask = views < v80_likes
    fit_mask_like = good_mask & mid_mask

    if fit_mask_like.sum() < 5:
        fit_mask_like = np.ones_like(views, dtype=bool)

    x_fit = logL[fit_mask_like]
    y_fit = logV[fit_mask_like]
    A2 = np.vstack([x_fit, np.ones(len(x_fit))]).T
    b1, b0 = np.linalg.lstsq(A2, y_fit, rcond=None)[0]

    like_b0 = float(b0)
    like_b1 = float(b1)

    logV_expected = like_b0 + like_b1 * logL
    V_expected = np.power(10.0, logV_expected)
    ratio_like = views / (V_expected + 1e-9)

    like_level = np.full(len(df), "", dtype=object)
    like_level[ratio_like >= LIKES_BIG_RATIO] = "X"
    like_level[(ratio_like >= LIKES_SUSPECT_RATIO) & (ratio_like < LIKES_BIG_RATIO)] = "△"

    # make_plots.py の合成（そのまま） :contentReference[oaicite:12]{index=12}
    nat_is_x = nat_level == "X"
    nat_is_d = nat_level == "△"
    nat_is_n = ~(nat_is_x | nat_is_d)

    like_is_x = like_level == "X"
    like_is_d = like_level == "△"
    like_is_n = ~(like_is_x | like_is_d)

    m_red = nat_is_x & like_is_x
    m_orange = (nat_is_x & like_is_d) | (nat_is_d & like_is_d) | (nat_is_d & like_is_x) | (nat_is_n & like_is_d)
    m_yellow = (nat_is_x & like_is_n) | (nat_is_n & like_is_x) | (nat_is_d & like_is_n)

    display = np.full(len(df), "NORMAL", dtype=object)
    display[m_yellow] = "YELLOW"
    display[m_orange] = "ORANGE"
    display[m_red] = "RED"

    anomaly_ratio = np.maximum(ratio_nat, ratio_like)

    points = []
    for i, row in df.reset_index(drop=True).iterrows():
        points.append(
            {
                "video_id": row["video_id"],
                "title": row["title"],
                "publishedAt": row["publishedAt"],
                "days": float(row["t_days"]),  # フロント互換用（daysでも同値）
                "t_days": float(row["t_days"]),
                "viewCount": int(row["viewCount"]),
                "likeCount": int(row["likeCount"]),
                "durationSec": int(row["durationSec"]),
                "isShort": bool(row["isShort"]),
                "predView": float(v_center_all[i]),
                "ratio_nat": float(ratio_nat[i]),
                "ratio_like": float(ratio_like[i]),
                "anomaly_ratio": float(anomaly_ratio[i]),
                "display_label": str(display[i]),
                "sticky_red": False,
            }
        )

    baseline = {
        # そのまま make_plots で出している “係数” と “しきい値” を持つ
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
            "likes_good_views_min": 100,
            "likes_mid_views_pct": 80,
        },
    }


    return points, baseline


def update_state_and_red(points, state_path: Path):
    prev = {}
    if state_path.exists():
        prev = json.loads(state_path.read_text(encoding="utf-8"))

    sticky = set(prev.get("sticky_red", []))

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
    state_path.write_text(json.dumps(state_obj, ensure_ascii=False, indent=2), encoding="utf-8")
    return state_obj


def main():
    if not YT_API_KEY:
        raise SystemExit("YT_API_KEY is required.")

    run_at = now_utc()
    run_at_utc = run_at.isoformat()

    ensure_dir(DATA_DIR / "channels")

    watch = read_watchlist()
    channels_index = []
    warnings = []

    for watch_key in watch:
        try:
            cid = resolve_channel_id(watch_key)
            ch = fetch_channel(cid)

            title = ch.get("snippet", {}).get("title", "")
            uploads = ch.get("contentDetails", {}).get("relatedPlaylists", {}).get("uploads")
            if not uploads:
                raise RuntimeError("uploads playlist not found")

            ch_dir = DATA_DIR / "channels" / cid
            ensure_dir(ch_dir)

            (ch_dir / "channel.json").write_text(json.dumps(ch, ensure_ascii=False, indent=2), encoding="utf-8")

            pli = fetch_latest_playlist_items(uploads, MAX_VIDEOS)
            (ch_dir / "latest_500_playlistItems.json").write_text(json.dumps(pli, ensure_ascii=False, indent=2), encoding="utf-8")

            video_ids = []
            for it in pli.get("items", []):
                vid = it.get("contentDetails", {}).get("videoId")
                if vid:
                    video_ids.append(vid)

            videos = fetch_videos(video_ids)

            points, baseline = compute_points_and_baseline(videos, run_at)

            (ch_dir / "latest_points.json").write_text(
                json.dumps({"run_at_utc": run_at_utc, "points": points}, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )

            latest = {"run_at_utc": run_at_utc, "baseline": baseline}

            # history
            (ch_dir / "runs.jsonl").open("a", encoding="utf-8").write(json.dumps(latest, ensure_ascii=False) + "\n")

            st = update_state_and_red(points, ch_dir / "state.json")
            (ch_dir / "latest.json").write_text(json.dumps(latest, ensure_ascii=False, indent=2), encoding="utf-8")

            max_anom = max((p.get("anomaly_ratio", 0.0) for p in points), default=0.0)

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

    index_obj = {"generated_at_utc": run_at_utc, "watch_count": len(watch), "warnings": warnings, "channels": channels_index}
    (DATA_DIR / "index.json").write_text(json.dumps(index_obj, ensure_ascii=False, indent=2), encoding="utf-8")

    auto = [ch["channel_id"] for ch in channels_index if ch.get("sticky_red_count", 0) >= 3]
    WATCHLIST_AUTO.write_text("\n".join(auto) + ("\n" if auto else ""), encoding="utf-8")

    ensure_dir(SITE_DATA_DIR)
    copy_tree(DATA_DIR, SITE_DATA_DIR)

    print("weekly done.")
    if warnings:
        print("warnings:", warnings)


if __name__ == "__main__":
    main()
