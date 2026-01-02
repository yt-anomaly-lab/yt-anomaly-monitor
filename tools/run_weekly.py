#!/usr/bin/env python3
import json
import os
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import List, Tuple


WATCHLIST_PATH = "data/watchlist.txt"
DATA_ROOT = "data"
CHANNELS_DIR = os.path.join(DATA_ROOT, "channels")


@dataclass
class WatchItem:
    raw: str                 # 入力行（UC... or @handle）
    kind: str                # "channel_id" or "handle"
    key: str                 # UC... or handle (without @)


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def read_watchlist(path: str) -> Tuple[List[WatchItem], List[str]]:
    """
    watchlist.txt を読み込み、監視対象の配列を返す。
    コメント行（#）と空行は無視。
    """
    items: List[WatchItem] = []
    warnings: List[str] = []

    if not os.path.exists(path):
        warnings.append(f"watchlist not found: {path} (created empty on first run)")
        return items, warnings

    with open(path, "r", encoding="utf-8") as f:
        for ln, line in enumerate(f, start=1):
            s = line.strip()
            if not s or s.startswith("#"):
                continue

            if s.startswith("@"):
                handle = s[1:].strip()
                if not handle:
                    warnings.append(f"line {ln}: invalid handle: '{line.rstrip()}'")
                    continue
                items.append(WatchItem(raw=s, kind="handle", key=handle))
            elif s.startswith("UC"):
                # 厳密な形式チェックは後で（今は軽く）
                items.append(WatchItem(raw=s, kind="channel_id", key=s))
            else:
                warnings.append(f"line {ln}: unsupported format: '{line.rstrip()}' (use UC... or @handle)")
    return items, warnings


def ensure_dirs() -> None:
    os.makedirs(DATA_ROOT, exist_ok=True)
    os.makedirs(CHANNELS_DIR, exist_ok=True)


def write_heartbeat() -> None:
    """
    既存の確認用。Actionsが動いたことを示すファイル。
    """
    payload = {
        "ok": True,
        "message": "run_weekly.py ran successfully",
        "run_at_utc": utc_now_iso(),
    }
    out_path = os.path.join(DATA_ROOT, "heartbeat.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)


def channel_dir_name(item: WatchItem) -> str:
    """
    @handle も channel_id も、まずは識別子として保存する。
    後で channel_id に正規化する段階を入れる予定。
    """
    if item.kind == "channel_id":
        return item.key
    # handle は 'handle__xxxx' で衝突回避
    return f"handle__{item.key}"


def append_jsonl_gz_placeholder(path: str, obj: dict) -> None:
    """
    今はまず JSONL を素で追記する（gzipは後で）。
    まず動く形を優先。
    """
    os.makedirs(os.path.dirname(path), exist_ok=True)
    line = json.dumps(obj, ensure_ascii=False)
    with open(path, "a", encoding="utf-8") as f:
        f.write(line + "\n")


def write_channel_run_stub(item: WatchItem) -> None:
    """
    監視対象1件につき、チャンネルフォルダを作って run を積む（ダミー）。
    後でここに YouTube API 取得と異常度計算を入れる。
    """
    ch_dir = os.path.join(CHANNELS_DIR, channel_dir_name(item))
    os.makedirs(ch_dir, exist_ok=True)

    run_at = utc_now_iso()
    run_obj = {
        "run_at_utc": run_at,
        "watch_key": item.raw,
        "status": "stub",
        "note": "This is a stub run. YouTube fetch/anomaly calc will be added next.",
        # 将来ここに：talent_view_day1 / anomaly_counts / red_top100_size など
    }

    # 履歴：runs.jsonl に追記
    runs_path = os.path.join(ch_dir, "runs.jsonl")
    append_jsonl_gz_placeholder(runs_path, run_obj)

    # 最新：latest.json
    latest_path = os.path.join(ch_dir, "latest.json")
    with open(latest_path, "w", encoding="utf-8") as f:
        json.dump(run_obj, f, ensure_ascii=False, indent=2)


def write_index_stub(items: List[WatchItem], warnings: List[str]) -> None:
    """
    フロントが参照できる最小の索引（stub）。
    後でランキング/異常度上位などをここから生成する。
    """
    index = {
        "generated_at_utc": utc_now_iso(),
        "watch_count": len(items),
        "warnings": warnings,
        "channels": [
            {
                "id": channel_dir_name(it),
                "watch_key": it.raw,
                "kind": it.kind,
            }
            for it in items
        ],
    }
    out_path = os.path.join(DATA_ROOT, "index.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(index, f, ensure_ascii=False, indent=2)


def main() -> None:
    ensure_dirs()

    items, warnings = read_watchlist(WATCHLIST_PATH)

    # 基盤確認用
    write_heartbeat()

    # watchlist が空でも index は作る
    for it in items:
        write_channel_run_stub(it)

    write_index_stub(items, warnings)

    print(f"watch items: {len(items)}")
    if warnings:
        print("warnings:")
        for w in warnings:
            print(" -", w)


if __name__ == "__main__":
    main()
