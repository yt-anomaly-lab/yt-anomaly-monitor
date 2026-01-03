#!/usr/bin/env python3
import os, json, time, math, argparse
from datetime import datetime, timezone
from pathlib import Path

import requests
import numpy as np
import pandas as pd
import statsmodels.formula.api as smf

# ============================
# make_plots.py のパラメータ（完全一致）
# ============================
NAT_QUANTILE = 0.6
NAT_UPPER_RATIO = 3.0
NAT_BIG_RATIO = 10.0

LIKES_SUSPECT_RATIO = 3.0
LIKES_BIG_RATIO = 10.0

# fit mask / filters
RECENT_DAYS_EXCLUDE = 7
NAT_BUZZ_TOP_PCT = 95
LIKES_GOOD_VIEWS_MIN = 100
LIKES_MID_VIEWS_PCT = 80

# ============================
# 運用パラメータ
# ============================
MAX_VIDEOS = 500
RED_TRACK_MAX = 100

EXCLUDE_SHORTS = True  # isShort 列があれば除外

YT_API_KEY = os.environ.get("YT_API_KEY", "").strip()

BASE_DIR = Path(__file__).resolve().parents[1]
DATA_DIR = BASE_DIR / "data"
SITE_DATA_DIR = BASE_DIR / "site" / "data"
WATCHLIST = DATA_DIR / "watchlist.txt"
WATCHLIST_AUTO = DATA_DIR / "watchlist_auto.txt"


def yt_get(url, params):
    r = requests.get(url, params=params, timeout=30)
    r.raise_for_status()
    return r.json()


def iso8601_duration_to_seconds(s):
    # e.g. "PT1H2M3S"
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


def resolve_channel_id(watch_key):
    """
    watch_key:
      - "UC..." channel id
      - "@handle" (or "handle") -> resolve via channels?forHandle
    """
    key = (watch_key or "").strip()
    if not key:
        raise ValueError("empty watch_key")

    if key.startswith("UC"):
        return key

    handle = key
    if handle.startswith("@"):
        handle = handle[1:]

    # YouTube Data API: channels?forHandle=
    url = "https://www.googleapis.com/youtube/v3/channels"
    params = {
        "part": "id",
        "forHandle": handle,
        "key": YT_API_KEY,
    }
    js = yt_get(url, params)
    items = js.get("items", [])
    if not items:
        raise RuntimeError(f"handle not found: {watch_key}")
    return items[0].get("id")


def fetch_channel(channel_id):
    url = "https://www.googleapis.com/youtube/v3/channels"
    params = {
        "part": "snippet,contentDetails",
        "id": channel_id,
        "key": YT_API_KEY,
    }
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
    # very small tree, so simple copy
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
        t_days = max(float(t_days), 1.0)  # clip(lower=1)

        viewCount = int(st.get("viewCount", 0) or 0)
        likeCount = int(st.get("likeCount", 0) or 0)

        durationSec = iso8601_duration_to_seconds(cd.get("duration", ""))
        isShort = durationSec <= 60

        rows.append(
            {
                "video_id": vid,
                "title": sn.get("title", ""),
                "publishedAt": pub_s,
                "days": t_days,
                "views": viewCount,
                "likes": likeCount,
                "durationSec": durationSec,
                "isShort": bool(isShort),
            }
        )

    df = pd.DataFrame(rows)
    if df.empty:
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

    if EXCLUDE_SHORTS and "isShort" in df.columns:
        df = df[~df["isShort"]].copy()

    # log-linear NAT: log(views) ~ days  (QuantReg)
    df["logv"] = np.log(np.clip(df["views"].astype(float), 1.0, None))

    # fit mask: exclude very recent days
    df_fit = df.copy()
    if RECENT_DAYS_EXCLUDE and RECENT_DAYS_EXCLUDE > 0:
        df_fit = df_fit[df_fit["days"] >= float(RECENT_DAYS_EXCLUDE)].copy()

    # NAT buzz top PCT exclusion
    if not df_fit.empty and NAT_BUZZ_TOP_PCT and 0 < NAT_BUZZ_TOP_PCT < 100:
        vcut = np.percentile(df_fit["views"].astype(float), NAT_BUZZ_TOP_PCT)
        df_fit = df_fit[df_fit["views"].astype(float) <= float(vcut)].copy()

    if df_fit.empty:
        # fallback: still produce points, but baseline NaN
        a_days = float("nan")
        b_days = float("nan")
    else:
        model = smf.quantreg("logv ~ days", df_fit)
        res = model.fit(q=NAT_QUANTILE)
        a_days = float(res.params.get("Intercept", float("nan")))
        b_days = float(res.params.get("days", float("nan")))

    # expected NAT for all points
    t = df["days"].astype(float).to_numpy()
    logv_center_all = a_days + b_days * t
    v_expected = np.exp(logv_center_all)
    ratio_nat = df["views"].astype(float).to_numpy() / np.clip(v_expected, 1.0, None)

    nat_level = np.array(["OK"] * len(df), dtype=object)
    nat_level[(ratio_nat >= NAT_UPPER_RATIO) & (ratio_nat < NAT_BIG_RATIO)] = "△"
    nat_level[ratio_nat >= NAT_BIG_RATIO] = "RED"

    # Likes x-shift: log(views) ~ log(likes)
    df2 = df.copy()
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

    # expected from likes for all points (if likes>=1)
    likes_all = np.clip(df["likes"].astype(float).to_numpy(), 1.0, None)
    logL_all = np.log(likes_all)
    logV_expected = like_b0 + like_b1 * logL_all
    v_expected_like = np.exp(logV_expected)
    ratio_like = df["views"].astype(float).to_numpy() / np.clip(v_expected_like, 1.0, None)

    like_level = np.array(["OK"] * len(df), dtype=object)
    like_level[(ratio_like >= LIKES_SUSPECT_RATIO) & (ratio_like < LIKES_BIG_RATIO)] = "△"
    like_level[ratio_like >= LIKES_BIG_RATIO] = "RED"

    points = []
    for i, r in df.reset_index(drop=True).iterrows():
        p = {
            "video_id": r["video_id"],
            "title": r["title"],
            "publishedAt": r["publishedAt"],
            "days": float(r["days"]),
            "views": int(r["views"]),
            "likes": int(r["likes"]),
            "ratio_nat": float(ratio_nat[i]),
            "ratio_like": float(ratio_like[i]),
            "nat_level": str(nat_level[i]),
            "like_level": str(like_level[i]),
        }
        # display label: prioritize nat red, then like red, then triangles
        if p["nat_level"] == "RED" or p["like_level"] == "RED":
            p["display_label"] = "RED"
        elif p["nat_level"] == "△" or p["like_level"] == "△":
            p["display_label"] = "△"
        else:
            p["display_label"] = "OK"

        # anomaly_ratio: for ranking, use max of ratios
        p["anomaly_ratio"] = float(max(p["ratio_nat"], p["ratio_like"]))
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
        },
    }

    return points, baseline


def update_state_and_red(points, state_path: Path):
    # state.json:
    # {
    #   "sticky_red": [video_id...],
    #   "red_top": [video_id...]
    # }
    sticky = set()
    if state_path.exists():
        try:
            old = json.loads(state_path.read_text(encoding="utf-8"))
            for vid in old.get("sticky_red", []):
                if vid:
                    sticky.add(vid)
        except Exception:
            pass

    # new sticky red
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


def append_watchlist_channel_id(channel_id: str) -> bool:
    """watchlist.txt に channel_id を追記する（既にあれば何もしない）
    戻り値: 追記したら True
    """
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
        # 念のため末尾改行を保証
        txt = WATCHLIST.read_text(encoding="utf-8")
        if txt and not txt.endswith("\n"):
            f.write("\n")
        f.write(channel_id + "\n")
    return True


def parse_args():
    p = argparse.ArgumentParser(description="Weekly (or on-demand) YouTube anomaly monitor data generator")
    p.add_argument(
        "--channel",
        help="Process only this channel too (@handle or UC... channelId). If not in watchlist, it will still be analyzed.",
        default="",
    )
    p.add_argument(
        "--auto_watch_red_top",
        type=int,
        default=0,
        help="If >0, append the channel_id to watchlist.txt when red_top_count >= this threshold.",
    )
    return p.parse_args()


def main():
    args = parse_args()

    if not YT_API_KEY:
        raise SystemExit("YT_API_KEY is required.")

    run_at = now_utc()
    run_at_utc = run_at.isoformat()

    ensure_dir(DATA_DIR / "channels")

    watch = read_watchlist()

    # on-demand channel (未監視でも解析)
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
                json.dumps(ch, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )

            pli = fetch_latest_playlist_items(uploads, MAX_VIDEOS)
            (ch_dir / "latest_500_playlistItems.json").write_text(
                json.dumps(pli, ensure_ascii=False, indent=2),
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
                json.dumps({"run_at_utc": run_at_utc, "points": points}, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )

            latest = {"run_at_utc": run_at_utc, "baseline": baseline}

            # history
            with (ch_dir / "runs.jsonl").open("a", encoding="utf-8") as f:
                f.write(json.dumps(latest, ensure_ascii=False) + "\n")

            st = update_state_and_red(points, ch_dir / "state.json")
            (ch_dir / "latest.json").write_text(
                json.dumps(latest, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )

            max_anom = max((p.get("anomaly_ratio", 0.0) for p in points), default=0.0)

            # on-demand auto watch: red_top_count >= N なら watchlist へ追加
            if args.auto_watch_red_top and int(args.auto_watch_red_top) > 0:
                red_top_count = len(st.get("red_top", []))
                if red_top_count >= int(args.auto_watch_red_top):
                    appended = append_watchlist_channel_id(cid)
                    if appended:
                        print(f"[ondemand] appended to watchlist: {cid} (red_top_count={red_top_count})")

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
    (DATA_DIR / "index.json").write_text(json.dumps(index_obj, ensure_ascii=False, indent=2), encoding="utf-8")

    # 自動watchlist（従来仕様: sticky_red_count >= 3）
    auto = [ch["channel_id"] for ch in channels_index if ch.get("sticky_red_count", 0) >= 3]
    WATCHLIST_AUTO.write_text("\n".join(auto) + ("\n" if auto else ""), encoding="utf-8")

    ensure_dir(SITE_DATA_DIR)
    copy_tree(DATA_DIR, SITE_DATA_DIR)

    print("weekly done.")
    if warnings:
        print("warnings:", warnings)


if __name__ == "__main__":
    main()
