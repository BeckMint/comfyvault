import argparse
import hashlib
import sqlite3
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from backend.config import DB_PATH, OUTPUT_DIR, THUMBS_DIR
from backend.server import _send_to_recycle_bin


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            chunk = f.read(1024 * 1024)
            if not chunk:
                break
            h.update(chunk)
    return h.hexdigest()


def compute_dhash(img_path: Path) -> Optional[int]:
    """Compute 64-bit difference hash (dHash) for visual identity."""
    try:
        with Image.open(img_path) as im:
            im = im.convert("L").resize((9, 8), Image.Resampling.BILINEAR)
            px = list(im.getdata())
            bits = 0
            for y in range(8):
                row_off = y * 9
                for x in range(8):
                    bits = (bits << 1) | (1 if px[row_off + x] > px[row_off + x + 1] else 0)
            return bits
    except Exception:
        return None


def score_asset(row: Dict[str, Any]) -> Tuple:
    """Higher score = better copy to KEEP (most complete metadata + highest quality)."""
    has_prompt = 1 if row["raw_prompt_json"] else 0
    has_workflow = 1 if row["raw_workflow_json"] else 0
    is_png = 1 if row["ext"].lower() == ".png" else 0
    pixels = int(row["width"] or 0) * int(row["height"] or 0)
    fsize = int(row["file_size"] or 0)
    has_user_meta = (1 if row["rating"] > 0 else 0) + (1 if row["flag"] == "pick" else 0) + (1 if row["notes"] else 0)
    depth = row["rel_path"].count("/")
    return (
        has_prompt + has_workflow,  # 1. Most complete ComfyUI metadata
        has_user_meta,              # 2. User ratings/notes
        pixels,                     # 3. Highest resolution
        is_png,                     # 4. Lossless PNG over JPG/WebP
        fsize,                      # 5. Highest quality / file size
        -depth,                     # 6. Cleaner / shallower folder path
        -row["id"],
    )


def find_duplicates() -> List[Dict[str, Any]]:
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    rows = [
        dict(r)
        for r in conn.execute(
            """
            SELECT id, rel_path, folder, filename, media_type, ext, file_size, width, height,
                   thumb_name, rating, flag, notes,
                   (raw_prompt_json IS NOT NULL) AS raw_prompt_json,
                   (raw_workflow_json IS NOT NULL) AS raw_workflow_json
            FROM assets
            WHERE is_deleted = 0
            """
        ).fetchall()
    ]
    conn.close()

    # Step 1: Exact binary duplicates (SHA-256)
    by_size = defaultdict(list)
    for r in rows:
        by_size[r["file_size"]].append(r)

    exact_groups: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    matched_ids = set()

    for fsize, group in by_size.items():
        if len(group) < 2 or fsize <= 0:
            continue
        for r in group:
            fp = OUTPUT_DIR / r["rel_path"]
            if not fp.exists():
                continue
            exact_groups[sha256_file(fp)].append(r)

    results = []
    for _h, grp in exact_groups.items():
        if len(grp) < 2:
            continue
        grp_sorted = sorted(grp, key=score_asset, reverse=True)
        for item in grp:
            matched_ids.add(item["id"])
        results.append({"reason": "exact_sha256", "keep": grp_sorted[0], "drops": grp_sorted[1:]})

    # Step 2: True visual duplicates (same dHash + same aspect ratio bucket, e.g. PNG vs re-encoded/downscaled/metadata-stripped copy)
    by_dhash: Dict[Tuple[int, int], List[Dict[str, Any]]] = defaultdict(list)
    for r in rows:
        if r["id"] in matched_ids or r["media_type"] != "image":
            continue
        src = (THUMBS_DIR / r["thumb_name"]) if r["thumb_name"] and (THUMBS_DIR / r["thumb_name"]).exists() else (OUTPUT_DIR / r["rel_path"])
        if not src.exists():
            continue
        dh = compute_dhash(src)
        if dh is None:
            continue
        w = max(1, int(r["width"] or 1))
        h = max(1, int(r["height"] or 1))
        aspect_bucket = round((w / h) * 20)
        by_dhash[(dh, aspect_bucket)].append(r)

    for _key, grp in by_dhash.items():
        if len(grp) < 2:
            continue
        grp_sorted = sorted(grp, key=score_asset, reverse=True)
        results.append({"reason": "visual_identical", "keep": grp_sorted[0], "drops": grp_sorted[1:]})

    return results


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true", help="Move duplicate files to Recycle Bin and remove from DB")
    args = parser.parse_args()

    groups = find_duplicates()
    total_drops = sum(len(g["drops"]) for g in groups)
    total_bytes = sum(d["file_size"] for g in groups for d in g["drops"])

    exact_cnt = sum(1 for g in groups if g["reason"] == "exact_sha256")
    vis_cnt = sum(1 for g in groups if g["reason"] == "visual_identical")

    print(f"Found {len(groups)} duplicate groups ({exact_cnt} exact binary, {vis_cnt} visually identical different quality/meta)")
    print(f"Redundant files to remove: {total_drops} ({total_bytes / (1024*1024):.1f} MB)")

    folder_pairs = defaultdict(int)
    for g in groups:
        k_top = g["keep"]["folder"].split("/")[0] if g["keep"]["folder"] else "(root)"
        for d in g["drops"]:
            d_top = d["folder"].split("/")[0] if d["folder"] else "(root)"
            folder_pairs[(k_top, d_top)] += 1

    print("\nKeep -> Drop folder breakdown:")
    for (kf, df), cnt in sorted(folder_pairs.items(), key=lambda x: -x[1])[:15]:
        print(f"  KEEP [{kf}]  -->  DROP [{df}] : {cnt} files")

    print("\nSample visual_identical groups:")
    vis_samples = [g for g in groups if g["reason"] == "visual_identical"][:5]
    for g in vis_samples:
        print(f"  [visual] KEEP: {g['keep']['rel_path']} ({g['keep']['width']}x{g['keep']['height']}, {g['keep']['file_size']//1024}KB, meta={g['keep']['raw_prompt_json']})")
        for d in g["drops"]:
            print(f"           DROP: {d['rel_path']} ({d['width']}x{d['height']}, {d['file_size']//1024}KB, meta={d['raw_prompt_json']})")

    if args.apply and total_drops > 0:
        drop_ids = [d["id"] for g in groups for d in g["drops"]]
        recycled = 0
        for g in groups:
            keep_fp = (OUTPUT_DIR / g["keep"]["rel_path"]).resolve()
            for d in g["drops"]:
                fp = OUTPUT_DIR / d["rel_path"]
                if fp.exists():
                    # Guard: NEVER delete if it resolves to the same underlying file (junction/hardlink/symlink)
                    try:
                        if os.path.samefile(keep_fp, fp):
                            continue
                    except Exception:
                        pass
                    if _send_to_recycle_bin(fp):
                        recycled += 1
        conn = sqlite3.connect(str(DB_PATH), timeout=30.0)
        for i in range(0, len(drop_ids), 400):
            chunk = drop_ids[i : i + 400]
            q = ",".join("?" for _ in chunk)
            conn.execute(f"DELETE FROM assets WHERE id IN ({q})", chunk)
        conn.commit()
        conn.close()
        print(f"\nAPPLIED: Moved {recycled} duplicate files to Windows Recycle Bin and removed {len(drop_ids)} DB entries.")


if __name__ == "__main__":
    main()
