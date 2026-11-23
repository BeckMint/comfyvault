import hashlib
import subprocess
from pathlib import Path
from typing import Optional

from PIL import Image, ImageOps

from .config import THUMBS_DIR, THUMB_MAX_WIDTH, THUMB_QUALITY, VIDEO_EXTS


def thumb_filename(rel_path: str, mtime_ns: int, file_size: int) -> str:
    key = hashlib.sha1(f"{rel_path}|{mtime_ns}|{file_size}".encode("utf-8")).hexdigest()[:20]
    return f"{key}.webp"


def ensure_thumbnail(file_path: Path, rel_path: str, mtime_ns: int, file_size: int) -> Optional[str]:
    """Generate a lightweight WebP thumbnail if not already cached. Returns thumb filename."""
    THUMBS_DIR.mkdir(parents=True, exist_ok=True)
    tname = thumb_filename(rel_path, mtime_ns, file_size)
    out_path = THUMBS_DIR / tname
    if out_path.exists() and out_path.stat().st_size > 0:
        return tname

    ext = file_path.suffix.lower()
    tmp_path = out_path.with_suffix(".tmp.webp")
    try:
        if ext in VIDEO_EXTS:
            # Fast single-frame extraction via ffmpeg
            proc = subprocess.run(
                [
                    "ffmpeg",
                    "-y",
                    "-ss",
                    "0.15",
                    "-i",
                    str(file_path),
                    "-vframes",
                    "1",
                    "-vf",
                    f"scale='min({THUMB_MAX_WIDTH},iw)':-2",
                    "-c:v",
                    "libwebp",
                    "-quality",
                    str(THUMB_QUALITY),
                    str(tmp_path),
                ],
                capture_output=True,
                stdin=subprocess.DEVNULL,
                timeout=8,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            if not tmp_path.exists() or tmp_path.stat().st_size == 0:
                # Fallback to frame 0
                subprocess.run(
                    [
                        "ffmpeg",
                        "-y",
                        "-i",
                        str(file_path),
                        "-vframes",
                        "1",
                        "-vf",
                        f"scale='min({THUMB_MAX_WIDTH},iw)':-2",
                        "-c:v",
                        "libwebp",
                        "-quality",
                        str(THUMB_QUALITY),
                        str(tmp_path),
                    ],
                    capture_output=True,
                    timeout=10,
                    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                )
            if tmp_path.exists() and tmp_path.stat().st_size > 0:
                tmp_path.replace(out_path)
                return tname
            return None
        else:
            with Image.open(file_path) as img:
                img = ImageOps.exif_transpose(img)
                if img.mode not in ("RGB", "RGBA"):
                    img = img.convert("RGB")
                if img.width > THUMB_MAX_WIDTH:
                    ratio = THUMB_MAX_WIDTH / float(img.width)
                    new_h = max(1, int(img.height * ratio))
                    img = img.resize((THUMB_MAX_WIDTH, new_h), Image.Resampling.LANCZOS)
                img.save(tmp_path, format="WEBP", quality=THUMB_QUALITY, method=4)
            if tmp_path.exists():
                tmp_path.replace(out_path)
                return tname
    except Exception:
        try:
            if tmp_path.exists():
                tmp_path.unlink()
        except Exception:
            pass
    return None
