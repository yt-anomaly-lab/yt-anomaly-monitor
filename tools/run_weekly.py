#!/usr/bin/env python3
import json
import os
from datetime import datetime, timezone

def main() -> None:
    os.makedirs("data", exist_ok=True)

    payload = {
        "ok": True,
        "message": "run_weekly.py ran successfully",
        "run_at_utc": datetime.now(timezone.utc).isoformat(),
    }

    out_path = os.path.join("data", "heartbeat.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)

    print(f"Wrote {out_path}")

if __name__ == "__main__":
    main()
