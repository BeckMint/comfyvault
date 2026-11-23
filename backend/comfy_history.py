import re
import sqlite3
import subprocess
from pathlib import Path
from typing import List, Optional, Tuple

from .config import COMFY_ROOT

COMFY_DB_PATH = COMFY_ROOT / "user" / "comfyui.db"


class GitVersionTimeline:
    """Reconstructs historical ComfyUI versions from local git reflog."""

    def __init__(self) -> None:
        # Sorted ascending by unix timestamp: [(ts, label), ...]
        self.events: List[Tuple[float, str]] = []
        self._load()

    def _load(self) -> None:
        try:
            proc = subprocess.run(
                ["git", "-C", str(COMFY_ROOT), "reflog", "--date=unix", "--format=%h|%gd|%gs"],
                capture_output=True,
                text=True,
                stdin=subprocess.DEVNULL,
                timeout=5,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            if proc.returncode != 0 or not proc.stdout:
                return
            raw_events: List[Tuple[float, str]] = []
            for line in proc.stdout.splitlines():
                parts = line.split("|", 2)
                if len(parts) < 3:
                    continue
                commit_hash, gd, subject = parts
                m = re.search(r"@\{(\d+)\}", gd)
                if not m:
                    continue
                ts = float(m.group(1))
                # Extract version tag if present (e.g. v0.37.0, v0.31.1)
                vm = re.search(r"(v\d+\.\d+(?:\.\d+)?)", subject)
                label = f"{vm.group(1)} ({commit_hash})" if vm else commit_hash
                raw_events.append((ts, label))
            raw_events.sort(key=lambda x: x[0])
            self.events = raw_events
        except Exception:
            self.events = []

    def resolve(self, file_ts: float) -> Optional[str]:
        if not self.events:
            return None
        matched = None
        for ts, label in self.events:
            if ts <= file_ts:
                matched = label
            else:
                break
        return matched or f"≤{self.events[0][1]}"


def inspect_comfy_native_db() -> dict:
    """Inspect ComfyUI's own user/comfyui.db if present."""
    if not COMFY_DB_PATH.exists():
        return {"exists": False}
    try:
        conn = sqlite3.connect(f"file:{COMFY_DB_PATH}?mode=ro", uri=True, timeout=3)
        tables = [r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()]
        counts = {}
        for t in tables:
            try:
                counts[t] = conn.execute(f'SELECT COUNT(*) FROM "{t}"').fetchone()[0]
            except Exception:
                counts[t] = -1
        conn.close()
        return {"exists": True, "tables": counts}
    except Exception as e:
        return {"exists": True, "error": str(e)}


if __name__ == "__main__":
    tl = GitVersionTimeline()
    print("Git timeline events:", tl.events)
    print("ComfyUI native DB:", inspect_comfy_native_db())
