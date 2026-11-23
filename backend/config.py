import os
import subprocess
from pathlib import Path

# Application version (increment patch +0.0.1 per iteration)
VAULT_VERSION = "0.1.6"

# Base paths
VAULT_ROOT = Path(__file__).resolve().parent.parent
PORTABLE_ROOT = VAULT_ROOT.parent
COMFY_ROOT = PORTABLE_ROOT / "ComfyUI"
OUTPUT_DIR = COMFY_ROOT / "output"
DATA_DIR = VAULT_ROOT / "data"
DB_PATH = DATA_DIR / "vault.db"
THUMBS_DIR = DATA_DIR / "thumbs"
FRONTEND_DIST = VAULT_ROOT / "frontend" / "dist"

# Server settings
VAULT_HOST = os.environ.get("COMFYVAULT_HOST", "127.0.0.1")
VAULT_PORT = int(os.environ.get("COMFYVAULT_PORT", "8189"))
COMFY_HOST = os.environ.get("COMFYUI_HOST", "127.0.0.1")
COMFY_PORT = int(os.environ.get("COMFYUI_PORT", "8188"))
COMFY_HTTP_URL = f"http://{COMFY_HOST}:{COMFY_PORT}"
COMFY_WS_URL = f"ws://{COMFY_HOST}:{COMFY_PORT}/ws"

# Supported media extensions
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"}
VIDEO_EXTS = {".mp4", ".webm", ".mov", ".mkv"}
MEDIA_EXTS = IMAGE_EXTS | VIDEO_EXTS

THUMB_MAX_WIDTH = 420
THUMB_QUALITY = 80


def ensure_dirs() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    THUMBS_DIR.mkdir(parents=True, exist_ok=True)


def detect_comfy_version() -> str:
    """Detect local ComfyUI git commit & date, cached by callers."""
    try:
        res = subprocess.run(
            ["git", "-C", str(COMFY_ROOT), "log", "-1", "--format=%h (%cs)"],
            capture_output=True,
            text=True,
            timeout=3,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        if res.returncode == 0 and res.stdout.strip():
            return res.stdout.strip()
    except Exception:
        pass
    return "unknown"
