#!/usr/bin/env python3
import json
import os
import sys
import time
import math
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Dict, List, Optional, Tuple

WATCHLIST_PATH = "data/watchlist.txt"
WATCHLIST_AUTO_PATH = "data/watchlist_auto.txt"

DATA_ROOT = "data"
CHANNELS_DIR = os.path.join(DATA_ROOT, "channels")

YOUTUBE_API_BASE = "https://www.googleapis.com/youtube/v3"

# ---- 異常度ラベル閾値（まずは固定で開始。後で“平常ブレ上限×3”方式に差し替え可） ----
YELLOW_TH = 3.0
ORANGE_TH = 5.0
RED_TH = 8.0

# 赤追跡上限
RED_TOP_MAX = 100

# 取得対象本数（直近500）
LATEST_MAX = 500

# API間引き
SLEEP_SEC = 0.08


@dataclass
class WatchItem:
    raw: str
    kind: str  # "channel_id" or "handle"
    key: str


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def ensure_dirs() -> None:
    os.makedirs(DATA_ROOT, exist_ok=True)
    os.makedirs(CHANNELS_DIR, exist_ok=True)


def read_watchlist(path: str) -> Tuple[List[WatchItem], List[str]]:
    items: List[WatchItem] = []
    warnings: List[str] = []
    if not os.path.exists(path):
        warnings.append(f"watchlist not found: {path}")
        return items, warnings

    with open(path, "r", encoding="utf-8") as f:
        for ln, line in enumerate(f, start=1):
            s = line.strip()
            if not s or s.startswith("#"):
                continue
            if s.startswith("@"):
                handle = s[1:].strip()
                if not handle:
                    warnings.append(f"line {ln}: invalid handle")
                    continue
                items.append(WatchItem(raw=s, kind="handle", key=handle))
            elif s.startswith("UC"):
                items.append(WatchItem(raw=s, kind="channel_id", key=s))
            else:
                warnings.append(f"line {ln}: unsupported format: {s} (use UC... or @handle)")
    return items, warnings


def write_heartbeat() -> None:
    payload = {"ok": True, "message": "run_weekly.py ran successfully", "run_at_utc": utc_now_iso()}
    with open(os.path.join(DATA_ROOT, "heartbeat.json"), "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)


def http_get_json(url: str, timeout: int = 30) -> Dict:
    req = urllib.request.Request(url, headers={"User-Agent": "yt-anomaly-monitor/0.1"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        body = resp.read()
    return json.loads(body.decode("utf-8"))


def yt_api_key() -> str:
    key = os.environ.get("YT_API_KEY", "").strip()
    if not key:
        raise RuntimeError("YT_API_KEY is not set (env or GitHub Actions secret).")
    return key


def yt_get(endpoint: str, params: Dict[str, str]) -> Dict:
    params = dict(params)
    params["key"] = yt_api_key()
    qs = urllib.parse.urlencode(params)
    url = f"{YOUTUBE_API_BASE}/{endpoint}?{qs}"
    data = http_get_json(url)
    time.sleep(SLEEP_SEC)
    return data


def save_json(path: str, obj: Dict) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)


def append_jsonl(path: str, obj: Dict) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "a", encoding="utf-8") as f:
        f.write(json.dumps(obj, ensure_ascii=False) + "\n")


def resolve_channel_id(item: WatchItem) -> Tuple[str, Dict]:
    if item.kind == "channel_id":
        info = yt_get("channels", {"part": "snippet,contentDetails,statistics", "id": item.key})
        if not info.get("items"):
            raise RuntimeError(f"channel not found: {item.key}")
        return info["items"][0]["id"], info["items"][0]

    info = yt_get("channels", {"part": "snippet,contentDetails,statistics", "forHandle": item.key})
    if not info.get("items"):
        raise RuntimeError(f"channel not found for handle: @{item.key}")
    return info["items"][0]["id"], info["items"][0]


def list_latest_from_uploads(uploads_playlist_id: str, max_results: int) -> List[Dict]:
    out: List[Dict] = []
    page_token: Optional[str] = None
    while len(out) < max_results:
        batch = min(50, max_results - len(out))
        params = {
            "part": "snippet,contentDetails",
            "playlistId": uploads_playlist_id,
            "maxResults": str(batch),
        }
        if page_token:
            params["pageToken"] = page_token
        data = yt_get("playlistItems", params)
        items = data.get("items", [])
        out.extend(items)
        page_token = data.get("nextPageToken")
        if not page_token or not items:
            break
    return out


def chunked(lst: List[str], n: int) -> List[List[str]]:
    return [lst[i : i + n] for i in range(0, len(lst), n)]


def parse_iso8601_z(dt_str: str) -> datetime:
    # 例: 2024-01-01T00:00:00Z
    if dt_str.endswith("Z"):
        dt_str = dt_str[:-1] + "+00:00"
    return datetime.fromisoformat(dt_str)


def iso_duration_to_seconds(d: str) -> int:
    # PT#H#M#S の雑パース（YouTubeのdurationはISO8601）
    # 例 PT5M13S, PT1H2M, PT30S
    if not d.startswith("PT"):
        return 0
    s = d[2:]
    num = ""
    sec = 0
    h = m = 0
    for ch in s:
        if ch.isdigit():
            num += ch
            continue
        if not num:
            continue
        v = int(num)
        num = ""
        if ch == "H":
            h = v
        elif ch == "M":
            m = v
        elif ch == "S":
            sec = v
    return h * 3600 + m * 60 + sec


def fetch_videos_details(video_ids: List[str]) -> Dict[str, Dict]:
    """
    videos.list を50件ずつ叩いて、必要項目をvideo_id->dictで返す
    """
    out: Dict[str, Dict] = {}
    for batch in chunked(video_ids, 50):
        data = yt_get(
            "videos",
            {
                "part": "snippet,contentDetails,statistics",
                "id": ",".join(batch),
                "maxResults": "50",
            },
        )
        for it in data.get("items", []):
            out[it["id"]] = it
    return out


def robust_median(values: List[float]) -> float:
    if not values:
        return 0.0
    vs = sorted(values)
    n = len(vs)
    mid = n // 2
    if n % 2 == 1:
        return float(vs[mid])
    return 0.5 * (vs[mid - 1] + vs[mid])


def mad(values: List[float], med: float) -> float:
    if not values:
        return 0.0
    dev = [abs(v - med) for v in values]
    return robust_median(dev)


def fit_loglog_regression(xs: List[float], ys: List[float]) -> Tuple[float, float]:
    """
    log10(y) = a + b*log10(x) の最小二乗（簡易）
    """
    if len(xs) < 2:
        return 0.0, 0.0
    lx = [math.log10(max(1e-6, x)) for x in xs]
    ly = [math.log10(max(1e-6, y)) for y in ys]
    n = len(lx)
    mx = sum(lx) / n
    my = sum(ly) / n
    sxx = sum((x - mx) ** 2 for x in lx)
    if sxx <= 1e-12:
        return my, 0.0
    sxy = sum((lx[i] - mx) * (ly[i] - my) for i in range(n))
    b = sxy / sxx
    a = my - b * mx
    return a, b


def predict_from_loglog(a: float, b: float, x: float) -> float:
    lx = math.log10(max(1e-6, x))
    ly = a + b * lx
    return 10 ** ly


def load_state(ch_dir: str) -> Dict:
    p = os.path.join(ch_dir, "state.json")
    if not os.path.exists(p):
        return {
            "sticky_red": {},      # video_id -> {"first_red_at":..., "max_score":..., "max_ratio":...}
            "red_top": [],         # video_id list
        }
    with open(p, "r", encoding="utf-8") as f:
        return json.load(f)


def save_state(ch_dir: str, state: Dict) -> None:
    save_json(os.path.join(ch_dir, "state.json"), state)


def label_from_ratio(r: float) -> str:
    if r >= RED_TH:
        return "RED"
    if r >= ORANGE_TH:
        return "ORANGE"
    if r >= YELLOW_TH:
        return "YELLOW"
    return "NORMAL"


def update_red_sets(state: Dict, video_id: str, ratio: float, run_at: str) -> None:
    sticky = state.setdefault("sticky_red", {})
    if ratio >= RED_TH:
        if video_id not in sticky:
            sticky[video_id] = {
                "first_red_at": run_at,
                "max_ratio": ratio,
            }
        else:
            sticky[video_id]["max_ratio"] = max(sticky[video_id].get("max_ratio", ratio), ratio)

    # red_top は「max_ratio」降順で上位100
    # stickyに入っているものだけ候補
    items = list(sticky.items())
    items.sort(key=lambda kv: kv[1].get("max_ratio", 0.0), reverse=True)
    state["red_top"] = [vid for vid, _ in items[:RED_TOP_MAX]]


def write_watchlist_auto(channel_ids: List[str]) -> None:
    # 手書きwatchlist.txtは触らず、自動生成だけ別ファイルにする
    lines = ["# auto-generated (channels with sticky RED count >= 3)\n"]
    for cid in sorted(set(channel_ids)):
        lines.append(cid + "\n")
    with open(WATCHLIST_AUTO_PATH, "w", encoding="utf-8") as f:
        f.writelines(lines)


def main() -> None:
    ensure_dirs()
    write_heartbeat()

    items, warnings = read_watchlist(WATCHLIST_PATH)

    index = {
        "generated_at_utc": utc_now_iso(),
        "watch_count": len(items),
        "warnings": warnings,
        "channels": [],
    }

    auto_watch_channels: List[str] = []

    if not items:
        save_json(os.path.join(DATA_ROOT, "index.json"), index)
        print("watchlist empty: nothing to fetch")
        return

    run_at = utc_now_iso()

    for it in items:
        try:
            channel_id, ch_info = resolve_channel_id(it)
            uploads = ch_info["contentDetails"]["relatedPlaylists"]["uploads"]
            ch_dir = os.path.join(CHANNELS_DIR, channel_id)
            os.makedirs(ch_dir, exist_ok=True)

            # チャンネル情報保存
            save_json(os.path.join(ch_dir, "channel.json"), ch_info)

            # 直近最大500本
            plist_items = list_latest_from_uploads(uploads, LATEST_MAX)
            save_json(os.path.join(ch_dir, "latest_500_playlistItems.json"), {"items": plist_items})

            # video_id抽出
            video_ids: List[str] = []
            pub_map: Dict[str, str] = {}
            title_map: Dict[str, str] = {}
            for pi in plist_items:
                vid = pi.get("contentDetails", {}).get("videoId")
                sn = pi.get("snippet", {}) or {}
                if not vid:
                    continue
                video_ids.append(vid)
                pub_map[vid] = sn.get("publishedAt", "")
                title_map[vid] = sn.get("title", "")

            # details取得
            details = fetch_videos_details(video_ids)

            # 異常度用の学習データ（Shortは除外して基準線を作る）
            xs_days: List[float] = []
            ys_views: List[float] = []

            now = datetime.now(timezone.utc)

            per_video: List[Dict] = []
            for vid in video_ids:
                itv = details.get(vid)
                if not itv:
                    continue

                stats = itv.get("statistics", {}) or {}
                snippet = itv.get("snippet", {}) or {}
                cdet = itv.get("contentDetails", {}) or {}

                view = int(stats.get("viewCount", 0) or 0)
                like = int(stats.get("likeCount", 0) or 0)

                published_at = snippet.get("publishedAt") or pub_map.get(vid, "")
                if not published_at:
                    continue
                dt = parse_iso8601_z(published_at)
                days = max(1.0, (now - dt).total_seconds() / 86400.0)

                duration_sec = iso_duration_to_seconds(cdet.get("duration", ""))
                is_short = duration_sec <= 60  # ざっくり判定（後で厳密化してもOK）

                # 基準線用（Short除外、viewが極端に小さすぎるものも除外）
                if (not is_short) and view >= 100:
                    xs_days.append(days)
                    ys_views.append(view)

                per_video.append(
                    {
                        "video_id": vid,
                        "title": title_map.get(vid, ""),
                        "publishedAt": published_at,
                        "days": days,
                        "viewCount": view,
                        "likeCount": like,
                        "durationSec": duration_sec,
                        "isShort": is_short,
                    }
                )

            # 基準線（log-log回帰）
            a, b = fit_loglog_regression(xs_days, ys_views)

            # 残差から平常ブレ感を推定（MAD）
            residuals: List[float] = []
            for i in range(len(xs_days)):
                pred = max(1.0, predict_from_loglog(a, b, xs_days[i]))
                r = ys_views[i] / pred
                residuals.append(math.log10(max(1e-6, r)))
            med_res = robust_median(residuals)
            mad_res = mad(residuals, med_res)
            # “平常上限”の参考（log10空間で median + 3*MAD）
            upper_log = med_res + 3.0 * mad_res
            upper_ratio = 10 ** upper_log if mad_res > 0 else 3.0  # 退避

            # like基準（like/viewの中央値を期待値として使う）
            like_rates = []
            for v in per_video:
                if v["viewCount"] >= 100 and v["likeCount"] > 0:
                    like_rates.append(v["likeCount"] / max(1.0, v["viewCount"]))
            med_like_rate = robust_median(like_rates) if like_rates else 0.02

            # state（sticky赤・赤top100）
            state = load_state(ch_dir)

            # 動画ごとの異常度計算
            red_count_now = 0
            points: List[Dict] = []
            for v in per_video:
                pred_view = max(1.0, predict_from_loglog(a, b, v["days"]))
                ratio_nat = v["viewCount"] / pred_view

                exp_like = max(1.0, v["viewCount"] * med_like_rate)
                ratio_like = v["likeCount"] / exp_like if exp_like > 0 else 0.0

                # 異常度は「自然流入乖離」と「いいね乖離」の強い方
                anomaly_ratio = max(ratio_nat, ratio_like)

                observed_label = label_from_ratio(anomaly_ratio)

                # sticky赤はREDのみ固定（赤は消さない）
                update_red_sets(state, v["video_id"], anomaly_ratio, run_at)
                sticky_red = v["video_id"] in state.get("sticky_red", {})

                display_label = "RED" if sticky_red else observed_label
                if display_label == "RED":
                    red_count_now += 1

                points.append(
                    {
                        **v,
                        "predView": pred_view,
                        "ratio_nat": ratio_nat,
                        "ratio_like": ratio_like,
                        "anomaly_ratio": anomaly_ratio,
                        "observed_label": observed_label,
                        "display_label": display_label,
                        "sticky_red": sticky_red,
                    }
                )

            save_state(ch_dir, state)

            sticky_red_count = len(state.get("sticky_red", {}))
            red_top = state.get("red_top", [])

            # 監視条件：sticky赤が3件以上
            if sticky_red_count >= 3:
                auto_watch_channels.append(channel_id)

            # ラン用サマリ
            # “ワースト”指標用に、今回の最大異常度も持つ
            max_anom = max((p["anomaly_ratio"] for p in points), default=0.0)

            run_obj = {
                "run_at_utc": run_at,
                "watch_key": it.raw,
                "channel_id": channel_id,
                "latest_count": len(plist_items),
                "points_count": len(points),
                "baseline": {"a": a, "b": b, "upper_ratio_ref": upper_ratio, "med_like_rate": med_like_rate},
                "sticky_red_count": sticky_red_count,
                "red_top_count": len(red_top),
                "max_anomaly_ratio_this_run": max_anom,
                "status": "analyzed",
            }

            append_jsonl(os.path.join(ch_dir, "runs.jsonl"), run_obj)
            save_json(os.path.join(ch_dir, "latest.json"), run_obj)

            # フロント用：最新点群（まずはJSON。後でgzip化）
            save_json(os.path.join(ch_dir, "latest_points.json"), {"run_at_utc": run_at, "points": points})

            index["channels"].append(
                {
                    "channel_id": channel_id,
                    "watch_key": it.raw,
                    "title": (ch_info.get("snippet", {}) or {}).get("title", ""),
                    "sticky_red_count": sticky_red_count,
                    "red_top_count": len(red_top),
                    "max_anomaly_ratio": max_anom,
                }
            )

            print(f"[OK] {it.raw} -> {channel_id} : videos={len(points)} sticky_red={sticky_red_count} max={max_anom:.2f}")

        except Exception as e:
            print(f"[NG] {it.raw}: {e}", file=sys.stderr)

    # 全体index保存（ランキングの元）
    index["generated_at_utc"] = utc_now_iso()
    save_json(os.path.join(DATA_ROOT, "index.json"), index)

    # 自動監視対象
    write_watchlist_auto(auto_watch_channels)


if __name__ == "__main__":
    main()
