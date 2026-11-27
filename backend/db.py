import json
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import quote

from .config import COMFY_ROOT, DB_PATH, ensure_dirs
from .parser import classify_model_family


def _node_id_sort_key(nid: str) -> Tuple[Any, ...]:
    parts = []
    for seg in str(nid).split(":"):
        try:
            parts.append((0, int(seg)))
        except ValueError:
            parts.append((1, seg))
    return tuple(parts)


def _extract_reference_images(
    reference_image: Optional[str],
    raw_prompt_json: Optional[str],
) -> List[Dict[str, str]]:
    """Collect all reference images for an asset in deterministic order:
    1) Reverse-prompting reference image stored in data/ref_images/
    2) Workflow LoadImage input images found in raw_prompt_json (sorted by node ID)
    """
    refs: List[Dict[str, str]] = []
    seen_urls: set = set()

    if reference_image:
        url = f"/api/ref-images/{reference_image}"
        seen_urls.add(url)
        refs.append(
            {
                "url": url,
                "label": "反推参考原图",
                "source": "reverse_prompt",
                "filename": str(reference_image),
            }
        )

    if raw_prompt_json and ("LoadImage" in raw_prompt_json or "load_image" in raw_prompt_json or "Load Image" in raw_prompt_json):
        try:
            prompt = json.loads(raw_prompt_json)
        except Exception:
            prompt = None
        if isinstance(prompt, dict):
            input_root = COMFY_ROOT / "input"
            found: List[Tuple[str, str, str]] = []
            for nid, node in prompt.items():
                if not isinstance(node, dict):
                    continue
                ct = str(node.get("class_type") or "")
                ctl = ct.lower().replace(" ", "")
                if "loadimage" not in ctl and "load_image" not in ctl:
                    continue
                if "output" in ctl and "loadimageoutput" in ctl:
                    continue
                inputs = node.get("inputs")
                if not isinstance(inputs, dict):
                    continue
                raw_img = inputs.get("image") or inputs.get("image_path")
                if not isinstance(raw_img, str):
                    continue
                img_name = raw_img.strip()
                if not img_name:
                    continue
                # Strip ComfyUI UI annotations like "foo.png [input]"
                if img_name.endswith(" [input]"):
                    img_name = img_name[:-8].strip()
                norm_name = img_name.replace("\\", "/").lstrip("/")
                if not norm_name or ".." in norm_name.split("/"):
                    continue
                # Only include if the input image file still exists on disk
                if not (input_root / norm_name).is_file():
                    continue
                title = str((node.get("_meta") or {}).get("title") or "").strip()
                label = title or f"参考图 #{nid}"
                found.append((str(nid), norm_name, label))

            found.sort(key=lambda x: _node_id_sort_key(x[0]))
            for _nid, norm_name, label in found:
                url = f"/api/comfy/input-image?name={quote(norm_name, safe='/')}"
                if url in seen_urls:
                    continue
                seen_urls.add(url)
                refs.append(
                    {
                        "url": url,
                        "label": label,
                        "source": "workflow_input",
                        "filename": norm_name,
                    }
                )

    return refs


class VaultDB:
    def __init__(self, db_path: Path = DB_PATH):
        ensure_dirs()
        self.db_path = db_path
        self._local = threading.local()
        self._write_lock = threading.RLock()
        self._init_schema()

    def _conn(self) -> sqlite3.Connection:
        conn = getattr(self._local, "conn", None)
        if conn is None:
            conn = sqlite3.connect(str(self.db_path), timeout=30.0, check_same_thread=False)
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA journal_mode=WAL;")
            conn.execute("PRAGMA synchronous=NORMAL;")
            conn.execute("PRAGMA temp_store=MEMORY;")
            conn.execute("PRAGMA cache_size=-32000;")
            conn.execute("PRAGMA foreign_keys=ON;")
            self._local.conn = conn
        return conn

    def _init_schema(self) -> None:
        with self._write_lock:
            conn = self._conn()
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS assets (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    rel_path TEXT UNIQUE NOT NULL,
                    folder TEXT NOT NULL DEFAULT '',
                    filename TEXT NOT NULL,
                    media_type TEXT NOT NULL DEFAULT 'image',
                    ext TEXT NOT NULL DEFAULT '.png',
                    file_size INTEGER NOT NULL DEFAULT 0,
                    mtime_ns INTEGER NOT NULL DEFAULT 0,
                    created_at REAL NOT NULL DEFAULT 0,
                    width INTEGER NOT NULL DEFAULT 0,
                    height INTEGER NOT NULL DEFAULT 0,
                    duration REAL,
                    fps REAL,
                    thumb_name TEXT,
                    comfy_version TEXT,
                    gen_duration_sec REAL,
                    workflow_hash TEXT,
                    workflow_name TEXT,
                    recipe_hash TEXT,
                    base_model TEXT,
                    primary_prompt TEXT NOT NULL DEFAULT '',
                    all_prompts_text TEXT NOT NULL DEFAULT '',
                    prompts_json TEXT,
                    models_json TEXT,
                    loras_json TEXT,
                    params_json TEXT,
                    seed_targets_json TEXT,
                    param_targets_json TEXT,
                    raw_prompt_json TEXT,
                    raw_workflow_json TEXT,
                    seed INTEGER,
                    steps INTEGER,
                    cfg REAL,
                    sampler TEXT,
                    scheduler TEXT,
                    rating INTEGER NOT NULL DEFAULT 0,
                    flag TEXT NOT NULL DEFAULT '',
                    notes TEXT NOT NULL DEFAULT '',
                    parent_id INTEGER,
                    is_deleted INTEGER NOT NULL DEFAULT 0
                );

                CREATE INDEX IF NOT EXISTS idx_assets_created ON assets(is_deleted, created_at DESC);
                CREATE INDEX IF NOT EXISTS idx_assets_folder ON assets(is_deleted, folder);
                CREATE INDEX IF NOT EXISTS idx_assets_recipe ON assets(is_deleted, recipe_hash);
                CREATE INDEX IF NOT EXISTS idx_assets_workflow ON assets(is_deleted, workflow_hash);
                CREATE INDEX IF NOT EXISTS idx_assets_model ON assets(is_deleted, base_model);
                CREATE INDEX IF NOT EXISTS idx_assets_rating ON assets(is_deleted, rating DESC, created_at DESC);
                CREATE INDEX IF NOT EXISTS idx_assets_flag ON assets(is_deleted, flag);
                CREATE INDEX IF NOT EXISTS idx_assets_parent ON assets(parent_id);

                CREATE TABLE IF NOT EXISTS asset_loras (
                    asset_id INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
                    lora_name TEXT NOT NULL,
                    strength_model REAL NOT NULL DEFAULT 1.0,
                    strength_clip REAL NOT NULL DEFAULT 1.0,
                    enabled INTEGER NOT NULL DEFAULT 1
                );
                CREATE INDEX IF NOT EXISTS idx_asset_loras_name ON asset_loras(lora_name);
                CREATE INDEX IF NOT EXISTS idx_asset_loras_asset ON asset_loras(asset_id);

                CREATE TABLE IF NOT EXISTS asset_models (
                    asset_id INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
                    category TEXT NOT NULL,
                    model_name TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_asset_models_name ON asset_models(model_name);
                CREATE INDEX IF NOT EXISTS idx_asset_models_asset ON asset_models(asset_id);

                CREATE TABLE IF NOT EXISTS tags (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT UNIQUE NOT NULL,
                    color TEXT NOT NULL DEFAULT '#6366f1'
                );

                CREATE TABLE IF NOT EXISTS asset_tags (
                    asset_id INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
                    tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
                    PRIMARY KEY (asset_id, tag_id)
                );
                CREATE INDEX IF NOT EXISTS idx_asset_tags_tag ON asset_tags(tag_id);

                CREATE TABLE IF NOT EXISTS recipe_notes (
                    recipe_hash TEXT PRIMARY KEY,
                    title TEXT NOT NULL DEFAULT '',
                    notes TEXT NOT NULL DEFAULT '',
                    updated_at REAL NOT NULL DEFAULT 0
                );

                CREATE TABLE IF NOT EXISTS snippets (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    title TEXT NOT NULL,
                    category TEXT NOT NULL DEFAULT '通用',
                    content TEXT NOT NULL,
                    notes TEXT NOT NULL DEFAULT '',
                    created_at REAL NOT NULL,
                    updated_at REAL NOT NULL
                );

                CREATE TABLE IF NOT EXISTS workflow_aliases (
                    workflow_hash TEXT PRIMARY KEY,
                    custom_name TEXT NOT NULL DEFAULT '',
                    updated_at REAL NOT NULL DEFAULT 0
                );

                CREATE TABLE IF NOT EXISTS settings (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS workflow_files_cache (
                    path TEXT PRIMARY KEY,
                    base_dir TEXT NOT NULL,
                    rel_path TEXT NOT NULL,
                    folder TEXT NOT NULL,
                    name TEXT NOT NULL,
                    file_size INTEGER NOT NULL,
                    mtime REAL NOT NULL,
                    mtime_ns INTEGER NOT NULL,
                    format TEXT NOT NULL,
                    node_count INTEGER NOT NULL
                );

                CREATE VIRTUAL TABLE IF NOT EXISTS assets_fts USING fts5(
                    filename,
                    all_prompts_text,
                    notes,
                    base_model,
                    workflow_name,
                    lora_names,
                    content=''
                );
                """
            )
            conn.commit()
            # Schema migration: add model_family / is_hidden columns if missing
            cols = {r[1] for r in conn.execute("PRAGMA table_info(assets)").fetchall()}
            if "model_family" not in cols:
                conn.execute("ALTER TABLE assets ADD COLUMN model_family TEXT")
                conn.commit()
            if "is_hidden" not in cols:
                conn.execute("ALTER TABLE assets ADD COLUMN is_hidden INTEGER NOT NULL DEFAULT 0")
                conn.commit()
            if "reference_image" not in cols:
                conn.execute("ALTER TABLE assets ADD COLUMN reference_image TEXT")
                conn.commit()
            conn.execute("CREATE INDEX IF NOT EXISTS idx_assets_family ON assets(is_deleted, model_family)")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_assets_hidden ON assets(is_deleted, is_hidden)")
            conn.commit()
            self._backfill_model_families(conn)

    def _backfill_model_families(self, conn: sqlite3.Connection) -> None:
        rows = conn.execute(
            "SELECT id, base_model, model_family FROM assets WHERE base_model IS NOT NULL AND base_model != ''"
        ).fetchall()
        if not rows:
            return
        updates = []
        for r in rows:
            fam = classify_model_family(r["base_model"])
            if fam != r["model_family"]:
                updates.append((fam, r["id"]))
        if updates:
            conn.executemany("UPDATE assets SET model_family = ? WHERE id = ?", updates)
            conn.commit()
            conn.commit()

    def _sync_fts(self, conn: sqlite3.Connection, asset_id: int) -> None:
        # Search uses indexed LIKE queries directly on assets & asset_loras (supports Chinese & substrings)
        return

    def get_existing_file_map(self) -> Dict[str, Tuple[int, int, int, Optional[str]]]:
        """Return {rel_path: (id, mtime_ns, file_size, thumb_name)} for fast incremental scan."""
        rows = self._conn().execute(
            "SELECT id, rel_path, mtime_ns, file_size, thumb_name FROM assets"
        ).fetchall()
        return {r["rel_path"]: (r["id"], r["mtime_ns"], r["file_size"], r["thumb_name"]) for r in rows}

    def upsert_asset(self, record: Dict[str, Any]) -> int:
        ids = self.upsert_assets_batch([record])
        return ids[0]

    def upsert_assets_batch(self, records: List[Dict[str, Any]]) -> List[int]:
        if not records:
            return []
        asset_ids: List[int] = []
        with self._write_lock:
            conn = self._conn()
            for record in records:
                existing = conn.execute(
                    "SELECT id, comfy_version, gen_duration_sec, parent_id, reference_image, raw_prompt_json, prompts_json FROM assets WHERE rel_path = ?",
                    (record["rel_path"],),
                ).fetchone()

                loras = record.get("loras") or []
                models = record.get("models") or []
                params = record.get("params") or {}

                comfy_version = record.get("comfy_version") or (existing["comfy_version"] if existing else None)
                gen_dur = record.get("gen_duration_sec")
                if gen_dur is None and existing:
                    gen_dur = existing["gen_duration_sec"]
                parent_id = record.get("parent_id")
                if parent_id is None and existing:
                    parent_id = existing["parent_id"]
                reference_image = record.get("reference_image")
                if not reference_image and existing:
                    reference_image = existing["reference_image"]

                # Guard against disk re-scans (e.g. lossless WebP saved without EXIF prompt metadata)
                # wiping out rich prompt/LoRA/model metadata previously captured from ComfyUI /history!
                incoming_has_meta = bool(record.get("raw_prompt_json") or record.get("prompts"))
                existing_has_meta = bool(
                    existing
                    and (
                        existing["raw_prompt_json"]
                        or (existing["prompts_json"] and existing["prompts_json"] not in ("[]", ""))
                    )
                )
                if existing and existing_has_meta and not incoming_has_meta:
                    asset_id = existing["id"]
                    conn.execute(
                        """
                        UPDATE assets SET
                            rel_path=?, folder=?, filename=?, media_type=?, ext=?,
                            file_size=?, mtime_ns=?, created_at=?, width=?, height=?,
                            duration=?, fps=?, thumb_name=COALESCE(?, thumb_name),
                            comfy_version=COALESCE(?, comfy_version),
                            gen_duration_sec=COALESCE(?, gen_duration_sec),
                            parent_id=COALESCE(?, parent_id),
                            reference_image=COALESCE(?, reference_image),
                            is_deleted=0
                        WHERE id=?
                        """,
                        (
                            record["rel_path"],
                            record["folder"],
                            record["filename"],
                            record["media_type"],
                            record["ext"],
                            record["file_size"],
                            record["mtime_ns"],
                            record["created_at"],
                            record.get("width", 0),
                            record.get("height", 0),
                            record.get("duration"),
                            record.get("fps"),
                            record.get("thumb_name"),
                            comfy_version,
                            gen_dur,
                            parent_id,
                            reference_image,
                            asset_id,
                        ),
                    )
                    asset_ids.append(asset_id)
                    continue

                vals = (
                    record["rel_path"],
                    record["folder"],
                    record["filename"],
                    record["media_type"],
                    record["ext"],
                    record["file_size"],
                    record["mtime_ns"],
                    record["created_at"],
                    record.get("width", 0),
                    record.get("height", 0),
                    record.get("duration"),
                    record.get("fps"),
                    record.get("thumb_name"),
                    comfy_version,
                    gen_dur,
                    record.get("workflow_hash"),
                    record.get("workflow_name"),
                    record.get("recipe_hash"),
                    record.get("base_model"),
                    record.get("model_family") or classify_model_family(record.get("base_model")),
                    record.get("primary_prompt", ""),
                    record.get("all_prompts_text", ""),
                    json.dumps(record.get("prompts") or [], ensure_ascii=False),
                    json.dumps(models, ensure_ascii=False),
                    json.dumps(loras, ensure_ascii=False),
                    json.dumps(params, ensure_ascii=False),
                    json.dumps(record.get("seed_targets") or [], ensure_ascii=False),
                    json.dumps(record.get("param_targets") or {}, ensure_ascii=False),
                    json.dumps(record["raw_prompt_json"], ensure_ascii=False) if record.get("raw_prompt_json") else None,
                    json.dumps(record["raw_workflow_json"], ensure_ascii=False) if record.get("raw_workflow_json") else None,
                    params.get("seed"),
                    params.get("steps"),
                    params.get("cfg"),
                    params.get("sampler"),
                    params.get("scheduler"),
                    parent_id,
                    reference_image,
                )

                if existing:
                    asset_id = existing["id"]
                    conn.execute(
                        """
                        UPDATE assets SET
                            rel_path=?, folder=?, filename=?, media_type=?, ext=?,
                            file_size=?, mtime_ns=?, created_at=?, width=?, height=?,
                            duration=?, fps=?, thumb_name=COALESCE(?, thumb_name),
                            comfy_version=COALESCE(?, comfy_version),
                            gen_duration_sec=COALESCE(?, gen_duration_sec),
                            workflow_hash=?, workflow_name=?, recipe_hash=?, base_model=?, model_family=?,
                            primary_prompt=?, all_prompts_text=?, prompts_json=?, models_json=?,
                            loras_json=?, params_json=?, seed_targets_json=?, param_targets_json=?,
                            raw_prompt_json=COALESCE(?, raw_prompt_json),
                            raw_workflow_json=COALESCE(?, raw_workflow_json),
                            seed=?, steps=?, cfg=?, sampler=?, scheduler=?,
                            parent_id=COALESCE(?, parent_id),
                            reference_image=COALESCE(?, reference_image),
                            is_deleted=0
                        WHERE id=?
                        """,
                        vals + (asset_id,),
                    )
                else:
                    cur = conn.execute(
                        """
                        INSERT INTO assets (
                            rel_path, folder, filename, media_type, ext,
                            file_size, mtime_ns, created_at, width, height,
                            duration, fps, thumb_name, comfy_version, gen_duration_sec,
                            workflow_hash, workflow_name, recipe_hash, base_model, model_family,
                            primary_prompt, all_prompts_text, prompts_json, models_json,
                            loras_json, params_json, seed_targets_json, param_targets_json,
                            raw_prompt_json, raw_workflow_json,
                            seed, steps, cfg, sampler, scheduler, parent_id, reference_image
                        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                        """,
                        vals,
                    )
                    asset_id = int(cur.lastrowid)

                conn.execute("DELETE FROM asset_loras WHERE asset_id = ?", (asset_id,))
                if loras:
                    conn.executemany(
                        "INSERT INTO asset_loras(asset_id, lora_name, strength_model, strength_clip, enabled) VALUES (?,?,?,?,?)",
                        [
                            (
                                asset_id,
                                l["name"],
                                float(l.get("strength_model", 1.0)),
                                float(l.get("strength_clip", 1.0)),
                                1 if l.get("enabled", True) else 0,
                            )
                            for l in loras
                        ],
                    )

                conn.execute("DELETE FROM asset_models WHERE asset_id = ?", (asset_id,))
                if models:
                    conn.executemany(
                        "INSERT INTO asset_models(asset_id, category, model_name) VALUES (?,?,?)",
                        [(asset_id, m["category"], m["name"]) for m in models],
                    )
                asset_ids.append(asset_id)

            conn.commit()
        return asset_ids

    def update_thumb(self, asset_id: int, thumb_name: str) -> None:
        with self._write_lock:
            conn = self._conn()
            conn.execute("UPDATE assets SET thumb_name = ? WHERE id = ?", (thumb_name, asset_id))
            conn.commit()

    def update_asset_file_info(
        self,
        asset_id: int,
        width: int,
        height: int,
        file_size: int,
        mtime_ns: int,
        thumb_name: Optional[str],
    ) -> None:
        with self._write_lock:
            conn = self._conn()
            conn.execute(
                """
                UPDATE assets
                SET width = ?, height = ?, file_size = ?, mtime_ns = ?, thumb_name = COALESCE(?, thumb_name)
                WHERE id = ?
                """,
                (width, height, file_size, mtime_ns, thumb_name, asset_id),
            )
            conn.commit()

    def update_asset_prompt(self, asset_id: int, raw_prompt_json: Dict[str, Any], parsed: Dict[str, Any]) -> bool:
        """Directly overwrite an asset's stored prompt & parsed metadata in vault.db."""
        loras = parsed.get("loras") or []
        models = parsed.get("models") or []
        params = parsed.get("params") or {}
        with self._write_lock:
            conn = self._conn()
            cur = conn.execute(
                """
                UPDATE assets SET
                    workflow_hash=?, workflow_name=?, recipe_hash=?, base_model=?, model_family=?,
                    primary_prompt=?, all_prompts_text=?, prompts_json=?, models_json=?,
                    loras_json=?, params_json=?, seed_targets_json=?, param_targets_json=?,
                    raw_prompt_json=?,
                    seed=?, steps=?, cfg=?, sampler=?, scheduler=?
                WHERE id=?
                """,
                (
                    parsed.get("workflow_hash"),
                    parsed.get("workflow_name"),
                    parsed.get("recipe_hash"),
                    parsed.get("base_model"),
                    parsed.get("model_family") or classify_model_family(parsed.get("base_model")),
                    parsed.get("primary_prompt", ""),
                    parsed.get("all_prompts_text", ""),
                    json.dumps(parsed.get("prompts") or [], ensure_ascii=False),
                    json.dumps(models, ensure_ascii=False),
                    json.dumps(loras, ensure_ascii=False),
                    json.dumps(params, ensure_ascii=False),
                    json.dumps(parsed.get("seed_targets") or [], ensure_ascii=False),
                    json.dumps(parsed.get("param_targets") or {}, ensure_ascii=False),
                    json.dumps(raw_prompt_json, ensure_ascii=False),
                    params.get("seed"),
                    params.get("steps"),
                    params.get("cfg"),
                    params.get("sampler"),
                    params.get("scheduler"),
                    asset_id,
                ),
            )
            if cur.rowcount == 0:
                return False
            conn.execute("DELETE FROM asset_loras WHERE asset_id = ?", (asset_id,))
            if loras:
                conn.executemany(
                    "INSERT INTO asset_loras(asset_id, lora_name, strength_model, strength_clip, enabled) VALUES (?,?,?,?,?)",
                    [
                        (
                            asset_id,
                            l["name"],
                            float(l.get("strength_model", 1.0)),
                            float(l.get("strength_clip", 1.0)),
                            1 if l.get("enabled", True) else 0,
                        )
                        for l in loras
                    ],
                )
            conn.execute("DELETE FROM asset_models WHERE asset_id = ?", (asset_id,))
            if models:
                conn.executemany(
                    "INSERT INTO asset_models(asset_id, category, model_name) VALUES (?,?,?)",
                    [(asset_id, m["category"], m["name"]) for m in models],
                )
            conn.commit()
            return True

    def update_gen_duration_by_rel_path(self, rel_path: str, gen_duration_sec: float) -> bool:
        norm = (rel_path or "").replace("\\", "/").lstrip("/")
        if not norm or gen_duration_sec <= 0:
            return False
        with self._write_lock:
            conn = self._conn()
            cur = conn.execute(
                "UPDATE assets SET gen_duration_sec = ? WHERE rel_path = ? AND (gen_duration_sec IS NULL OR gen_duration_sec <= 0)",
                (round(float(gen_duration_sec), 2), norm),
            )
            conn.commit()
            return cur.rowcount > 0

    def get_assets_missing_thumbs(self) -> List[Dict[str, Any]]:
        rows = self._conn().execute(
            """
            SELECT id, rel_path, mtime_ns, file_size
            FROM assets
            WHERE is_deleted = 0 AND (thumb_name IS NULL OR thumb_name = '')
            ORDER BY created_at DESC
            """
        ).fetchall()
        return [dict(r) for r in rows]

    def remove_missing_paths(self, existing_rel_paths: set) -> int:
        with self._write_lock:
            conn = self._conn()
            rows = conn.execute("SELECT id, rel_path FROM assets WHERE is_deleted = 0").fetchall()
            to_del = [r["id"] for r in rows if r["rel_path"] not in existing_rel_paths]
            if not to_del:
                return 0
            for i in range(0, len(to_del), 400):
                chunk = to_del[i : i + 400]
                q = ",".join("?" for _ in chunk)
                conn.execute(f"DELETE FROM assets WHERE id IN ({q})", chunk)
            conn.commit()
            return len(to_del)

    def query_assets(
        self,
        *,
        folder: Optional[str] = None,
        folder_exact: bool = False,
        media_type: Optional[str] = None,
        search: Optional[str] = None,
        lora: Optional[str] = None,
        base_model: Optional[str] = None,
        model_family: Optional[str] = None,
        workflow_hash: Optional[str] = None,
        recipe_hash: Optional[str] = None,
        tag_id: Optional[int] = None,
        min_rating: Optional[int] = None,
        flag: Optional[str] = None,
        comfy_version: Optional[str] = None,
        show_deleted: bool = False,
        show_hidden: bool = False,
        collapse_recipes: bool = False,
        sort: str = "newest",
        limit: int = 300,
        offset: int = 0,
    ) -> Dict[str, Any]:
        conn = self._conn()
        where = ["a.is_deleted = ?"]
        params: List[Any] = [1 if show_deleted else 0]
        if not show_deleted and not show_hidden:
            where.append("COALESCE(a.is_hidden, 0) = 0")

        if folder is not None and folder != "__ALL__":
            if folder == "":
                if folder_exact:
                    where.append("a.folder = ''")
            else:
                if folder_exact:
                    where.append("a.folder = ?")
                    params.append(folder)
                else:
                    where.append("(a.folder = ? OR a.folder LIKE ?)")
                    params.extend([folder, f"{folder}/%"])

        if media_type in ("image", "video"):
            where.append("a.media_type = ?")
            params.append(media_type)

        if lora:
            where.append("EXISTS (SELECT 1 FROM asset_loras al WHERE al.asset_id = a.id AND al.lora_name = ?)")
            params.append(lora)

        if base_model:
            where.append("a.base_model = ?")
            params.append(base_model)

        if model_family:
            where.append("a.model_family = ?")
            params.append(model_family)

        if workflow_hash:
            where.append("a.workflow_hash = ?")
            params.append(workflow_hash)

        if recipe_hash:
            where.append("a.recipe_hash = ?")
            params.append(recipe_hash)

        if tag_id is not None:
            where.append("EXISTS (SELECT 1 FROM asset_tags at WHERE at.asset_id = a.id AND at.tag_id = ?)")
            params.append(tag_id)

        if min_rating is not None and min_rating > 0:
            where.append("a.rating >= ?")
            params.append(min_rating)

        if flag in ("pick", "reject"):
            where.append("a.flag = ?")
            params.append(flag)

        if comfy_version:
            where.append("a.comfy_version = ?")
            params.append(comfy_version)

        if search and search.strip():
            q = search.strip()
            # Use LIKE fallback for Chinese/special chars alongside FTS5
            like = f"%{q}%"
            where.append(
                "(a.filename LIKE ? OR a.all_prompts_text LIKE ? OR a.notes LIKE ? OR a.base_model LIKE ? OR EXISTS (SELECT 1 FROM asset_loras al WHERE al.asset_id = a.id AND al.lora_name LIKE ?))"
            )
            params.extend([like, like, like, like, like])

        where_sql = " AND ".join(where)

        order_map = {
            "newest": "a.created_at DESC, a.id DESC",
            "oldest": "a.created_at ASC, a.id ASC",
            "rating": "a.rating DESC, a.created_at DESC",
            "largest": "a.file_size DESC, a.created_at DESC",
            "name": "a.filename ASC",
        }
        order_sql = order_map.get(sort, order_map["newest"])

        if collapse_recipes:
            # Show 1 representative (highest rating then newest) per recipe_hash (NULL recipes stay ungrouped)
            base_cte = f"""
                WITH filtered AS (
                    SELECT a.* FROM assets a WHERE {where_sql}
                ),
                ranked AS (
                    SELECT f.*,
                           ROW_NUMBER() OVER (
                               PARTITION BY COALESCE(f.recipe_hash, 'single_' || f.id)
                               ORDER BY f.rating DESC, f.created_at DESC, f.id DESC
                           ) AS rn,
                           COUNT(*) OVER (
                               PARTITION BY COALESCE(f.recipe_hash, 'single_' || f.id)
                           ) AS grp_count
                    FROM filtered f
                )
            """
            total = conn.execute(f"{base_cte} SELECT COUNT(*) FROM ranked WHERE rn = 1", params).fetchone()[0]
            rows = conn.execute(
                f"""
                {base_cte}
                SELECT a.id, a.rel_path, a.folder, a.filename, a.media_type, a.ext,
                       a.file_size, a.created_at, a.width, a.height, a.duration, a.fps,
                       a.thumb_name, a.comfy_version, a.workflow_hash, a.workflow_name,
                       a.recipe_hash, a.base_model, a.primary_prompt, a.loras_json,
                       a.seed, a.steps, a.cfg, a.sampler, a.rating, a.flag, a.notes, a.parent_id,
                       COALESCE(a.is_hidden, 0) AS is_hidden,
                       a.reference_image,
                       a.grp_count AS recipe_count
                FROM ranked a
                WHERE a.rn = 1
                ORDER BY {order_sql}
                LIMIT ? OFFSET ?
                """,
                params + [limit, offset],
            ).fetchall()
        else:
            total = conn.execute(f"SELECT COUNT(*) FROM assets a WHERE {where_sql}", params).fetchone()[0]
            rows = conn.execute(
                f"""
                SELECT a.id, a.rel_path, a.folder, a.filename, a.media_type, a.ext,
                       a.file_size, a.created_at, a.width, a.height, a.duration, a.fps,
                       a.thumb_name, a.comfy_version, a.workflow_hash, a.workflow_name,
                       a.recipe_hash, a.base_model, a.primary_prompt, a.loras_json,
                       a.seed, a.steps, a.cfg, a.sampler, a.rating, a.flag, a.notes, a.parent_id,
                       COALESCE(a.is_hidden, 0) AS is_hidden,
                       a.reference_image,
                       a.raw_prompt_json,
                       CASE WHEN a.recipe_hash IS NULL THEN 1
                            ELSE (SELECT COUNT(*) FROM assets b WHERE b.is_deleted = 0 AND b.recipe_hash = a.recipe_hash)
                       END AS recipe_count
                FROM assets a
                WHERE {where_sql}
                ORDER BY {order_sql}
                LIMIT ? OFFSET ?
                """,
                params + [limit, offset],
            ).fetchall()

        asset_ids = [r["id"] for r in rows]
        tags_map: Dict[int, List[Dict[str, Any]]] = {}
        if asset_ids:
            q_ids = ",".join("?" for _ in asset_ids)
            t_rows = conn.execute(
                f"""
                SELECT at.asset_id, t.id, t.name, t.color
                FROM asset_tags at JOIN tags t ON t.id = at.tag_id
                WHERE at.asset_id IN ({q_ids})
                """,
                asset_ids,
            ).fetchall()
            for tr in t_rows:
                tags_map.setdefault(tr["asset_id"], []).append(
                    {"id": tr["id"], "name": tr["name"], "color": tr["color"]}
                )

        items = []
        for r in rows:
            loras_short = []
            if r["loras_json"]:
                try:
                    loras_short = [
                        {"name": l["name"], "strength_model": l.get("strength_model", 1.0), "enabled": l.get("enabled", True)}
                        for l in json.loads(r["loras_json"])
                        if l.get("enabled", True)
                    ]
                except Exception:
                    pass
            ref_images = _extract_reference_images(r["reference_image"], r["raw_prompt_json"])
            items.append(
                {
                    "id": r["id"],
                    "rel_path": r["rel_path"],
                    "folder": r["folder"],
                    "filename": r["filename"],
                    "media_type": r["media_type"],
                    "ext": r["ext"],
                    "file_size": r["file_size"],
                    "created_at": r["created_at"],
                    "width": r["width"] or 512,
                    "height": r["height"] or 512,
                    "duration": r["duration"],
                    "fps": r["fps"],
                    "thumb_url": f"/api/thumbs/{r['thumb_name']}" if r["thumb_name"] else f"/api/thumb-by-id/{r['id']}",
                    "media_url": f"/api/media/{r['id']}",
                    "comfy_version": r["comfy_version"],
                    "workflow_hash": r["workflow_hash"],
                    "workflow_name": r["workflow_name"],
                    "recipe_hash": r["recipe_hash"],
                    "recipe_count": r["recipe_count"],
                    "base_model": r["base_model"],
                    "primary_prompt": (r["primary_prompt"] or "")[:220],
                    "loras": loras_short,
                    "seed": r["seed"],
                    "steps": r["steps"],
                    "cfg": r["cfg"],
                    "sampler": r["sampler"],
                    "rating": r["rating"],
                    "flag": r["flag"],
                    "notes": r["notes"],
                    "parent_id": r["parent_id"],
                    "is_hidden": int(r["is_hidden"] or 0),
                    "reference_image": r["reference_image"],
                    "reference_image_url": ref_images[0]["url"] if ref_images else None,
                    "reference_images": ref_images,
                    "tags": tags_map.get(r["id"], []),
                }
            )

        return {"total": total, "items": items, "limit": limit, "offset": offset}

    def get_asset_detail(self, asset_id: int) -> Optional[Dict[str, Any]]:
        conn = self._conn()
        r = conn.execute("SELECT * FROM assets WHERE id = ?", (asset_id,)).fetchone()
        if not r:
            return None

        tags = [
            dict(t)
            for t in conn.execute(
                "SELECT t.id, t.name, t.color FROM asset_tags at JOIN tags t ON t.id = at.tag_id WHERE at.asset_id = ?",
                (asset_id,),
            ).fetchall()
        ]

        # Recipe siblings (same recipe_hash)
        siblings = []
        recipe_note = {"title": "", "notes": ""}
        if r["recipe_hash"]:
            sib_rows = conn.execute(
                """
                SELECT id, filename, thumb_name, media_type, seed, rating, flag, created_at, width, height
                FROM assets WHERE is_deleted = 0 AND recipe_hash = ?
                ORDER BY created_at DESC LIMIT 60
                """,
                (r["recipe_hash"],),
            ).fetchall()
            siblings = [
                {
                    "id": s["id"],
                    "filename": s["filename"],
                    "media_type": s["media_type"],
                    "seed": s["seed"],
                    "rating": s["rating"],
                    "flag": s["flag"],
                    "created_at": s["created_at"],
                    "width": s["width"],
                    "height": s["height"],
                    "thumb_url": f"/api/thumbs/{s['thumb_name']}" if s["thumb_name"] else f"/api/thumb-by-id/{s['id']}",
                }
                for s in sib_rows
            ]
            rn = conn.execute("SELECT title, notes FROM recipe_notes WHERE recipe_hash = ?", (r["recipe_hash"],)).fetchone()
            if rn:
                recipe_note = {"title": rn["title"], "notes": rn["notes"]}

        # Lineage: ancestors (walk up parent_id) + direct children
        ancestors = []
        curr_parent = r["parent_id"]
        seen = {asset_id}
        while curr_parent and curr_parent not in seen and len(ancestors) < 10:
            seen.add(curr_parent)
            p = conn.execute(
                "SELECT id, filename, thumb_name, media_type, created_at, rating, parent_id FROM assets WHERE id = ?",
                (curr_parent,),
            ).fetchone()
            if not p:
                break
            ancestors.append(
                {
                    "id": p["id"],
                    "filename": p["filename"],
                    "media_type": p["media_type"],
                    "created_at": p["created_at"],
                    "rating": p["rating"],
                    "thumb_url": f"/api/thumbs/{p['thumb_name']}" if p["thumb_name"] else f"/api/thumb-by-id/{p['id']}",
                }
            )
            curr_parent = p["parent_id"]
        ancestors.reverse()

        children = [
            {
                "id": c["id"],
                "filename": c["filename"],
                "media_type": c["media_type"],
                "created_at": c["created_at"],
                "rating": c["rating"],
                "thumb_url": f"/api/thumbs/{c['thumb_name']}" if c["thumb_name"] else f"/api/thumb-by-id/{c['id']}",
            }
            for c in conn.execute(
                "SELECT id, filename, thumb_name, media_type, created_at, rating FROM assets WHERE parent_id = ? AND is_deleted = 0 ORDER BY created_at DESC LIMIT 30",
                (asset_id,),
            ).fetchall()
        ]

        def _j(s, default):
            if not s:
                return default
            try:
                return json.loads(s)
            except Exception:
                return default

        ref_images = _extract_reference_images(r["reference_image"], r["raw_prompt_json"])

        return {
            "id": r["id"],
            "rel_path": r["rel_path"],
            "folder": r["folder"],
            "filename": r["filename"],
            "media_type": r["media_type"],
            "ext": r["ext"],
            "file_size": r["file_size"],
            "created_at": r["created_at"],
            "width": r["width"],
            "height": r["height"],
            "duration": r["duration"],
            "fps": r["fps"],
            "thumb_url": f"/api/thumbs/{r['thumb_name']}" if r["thumb_name"] else f"/api/thumb-by-id/{r['id']}",
            "media_url": f"/api/media/{r['id']}",
            "reference_image": r["reference_image"],
            "reference_image_url": ref_images[0]["url"] if ref_images else None,
            "reference_images": ref_images,
            "comfy_version": r["comfy_version"],
            "gen_duration_sec": r["gen_duration_sec"],
            "workflow_hash": r["workflow_hash"],
            "workflow_name": r["workflow_name"],
            "recipe_hash": r["recipe_hash"],
            "recipe_count": len(siblings) if siblings else 1,
            "recipe_note": recipe_note,
            "base_model": r["base_model"],
            "primary_prompt": r["primary_prompt"],
            "prompts": _j(r["prompts_json"], []),
            "models": _j(r["models_json"], []),
            "loras": _j(r["loras_json"], []),
            "params": _j(r["params_json"], {}),
            "seed_targets": _j(r["seed_targets_json"], []),
            "param_targets": _j(r["param_targets_json"], {}),
            "has_raw_prompt": bool(r["raw_prompt_json"]),
            "has_raw_workflow": bool(r["raw_workflow_json"]),
            "rating": r["rating"],
            "flag": r["flag"],
            "notes": r["notes"],
            "parent_id": r["parent_id"],
            "is_deleted": bool(r["is_deleted"]),
            "tags": tags,
            "siblings": siblings,
            "ancestors": ancestors,
            "children": children,
        }

    def get_raw_json(self, asset_id: int) -> Tuple[Optional[Dict[str, Any]], Optional[Dict[str, Any]]]:
        r = self._conn().execute(
            "SELECT raw_prompt_json, raw_workflow_json FROM assets WHERE id = ?", (asset_id,)
        ).fetchone()
        if not r:
            return None, None
        p = json.loads(r["raw_prompt_json"]) if r["raw_prompt_json"] else None
        w = json.loads(r["raw_workflow_json"]) if r["raw_workflow_json"] else None
        return p, w

    def get_asset_path_row(self, asset_id: int) -> Optional[Dict[str, Any]]:
        r = self._conn().execute(
            "SELECT id, rel_path, filename, media_type, mtime_ns, file_size, thumb_name FROM assets WHERE id = ?",
            (asset_id,),
        ).fetchone()
        return dict(r) if r else None

    def update_asset_meta(
        self,
        asset_id: int,
        *,
        rating: Optional[int] = None,
        flag: Optional[str] = None,
        notes: Optional[str] = None,
        is_deleted: Optional[int] = None,
        is_hidden: Optional[int] = None,
    ) -> bool:
        with self._write_lock:
            conn = self._conn()
            sets = []
            vals: List[Any] = []
            if rating is not None:
                sets.append("rating = ?")
                vals.append(max(0, min(5, int(rating))))
            if flag is not None:
                sets.append("flag = ?")
                vals.append(flag if flag in ("", "pick", "reject") else "")
            if notes is not None:
                sets.append("notes = ?")
                vals.append(str(notes))
            if is_deleted is not None:
                sets.append("is_deleted = ?")
                vals.append(1 if is_deleted else 0)
            if is_hidden is not None:
                sets.append("is_hidden = ?")
                vals.append(1 if is_hidden else 0)
            if not sets:
                return False
            vals.append(asset_id)
            conn.execute(f"UPDATE assets SET {', '.join(sets)} WHERE id = ?", vals)
            if notes is not None:
                self._sync_fts(conn, asset_id)
            conn.commit()
            return True

    def save_recipe_note(self, recipe_hash: str, title: str, notes: str) -> None:
        with self._write_lock:
            conn = self._conn()
            conn.execute(
                """
                INSERT INTO recipe_notes(recipe_hash, title, notes, updated_at)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(recipe_hash) DO UPDATE SET title=excluded.title, notes=excluded.notes, updated_at=excluded.updated_at
                """,
                (recipe_hash, title, notes, time.time()),
            )
            conn.commit()

    def get_sidebar_facets(self) -> Dict[str, Any]:
        conn = self._conn()
        counts = conn.execute(
            """
            SELECT
                COUNT(*) AS total,
                SUM(CASE WHEN media_type='image' THEN 1 ELSE 0 END) AS images,
                SUM(CASE WHEN media_type='video' THEN 1 ELSE 0 END) AS videos,
                SUM(CASE WHEN rating >= 4 THEN 1 ELSE 0 END) AS starred,
                SUM(CASE WHEN flag = 'pick' THEN 1 ELSE 0 END) AS picked,
                SUM(CASE WHEN flag = 'reject' THEN 1 ELSE 0 END) AS rejected
            FROM assets WHERE is_deleted = 0
            """
        ).fetchone()
        trash_count = conn.execute("SELECT COUNT(*) FROM assets WHERE is_deleted = 1").fetchone()[0]
        hidden_count = conn.execute("SELECT COUNT(*) FROM assets WHERE is_deleted = 0 AND COALESCE(is_hidden, 0) = 1").fetchone()[0]

        folders = [
            {"folder": r["folder"], "count": r["cnt"]}
            for r in conn.execute(
                "SELECT folder, COUNT(*) AS cnt FROM assets WHERE is_deleted = 0 GROUP BY folder ORDER BY folder DESC"
            ).fetchall()
        ]
        loras = [
            {"name": r["lora_name"], "count": r["cnt"]}
            for r in conn.execute(
                """
                SELECT al.lora_name, COUNT(DISTINCT al.asset_id) AS cnt
                FROM asset_loras al JOIN assets a ON a.id = al.asset_id
                WHERE a.is_deleted = 0 AND al.enabled = 1
                GROUP BY al.lora_name ORDER BY cnt DESC LIMIT 100
                """
            ).fetchall()
        ]
        model_families = [
            {"name": r["model_family"], "count": r["cnt"]}
            for r in conn.execute(
                """
                SELECT model_family, COUNT(*) AS cnt FROM assets
                WHERE is_deleted = 0 AND model_family IS NOT NULL AND model_family != ''
                GROUP BY model_family ORDER BY cnt DESC LIMIT 60
                """
            ).fetchall()
        ]
        models = [
            {"name": r["base_model"], "count": r["cnt"]}
            for r in conn.execute(
                """
                SELECT base_model, COUNT(*) AS cnt FROM assets
                WHERE is_deleted = 0 AND base_model IS NOT NULL AND base_model != ''
                GROUP BY base_model ORDER BY cnt DESC LIMIT 60
                """
            ).fetchall()
        ]
        workflows = [
            {"hash": r["workflow_hash"], "name": r["workflow_name"], "count": r["cnt"]}
            for r in conn.execute(
                """
                SELECT workflow_hash, MAX(workflow_name) AS workflow_name, COUNT(*) AS cnt
                FROM assets WHERE is_deleted = 0 AND workflow_hash IS NOT NULL
                GROUP BY workflow_hash ORDER BY cnt DESC LIMIT 50
                """
            ).fetchall()
        ]
        versions = [
            {"version": r["comfy_version"], "count": r["cnt"]}
            for r in conn.execute(
                """
                SELECT comfy_version, COUNT(*) AS cnt FROM assets
                WHERE is_deleted = 0 AND comfy_version IS NOT NULL AND comfy_version != ''
                GROUP BY comfy_version ORDER BY cnt DESC
                """
            ).fetchall()
        ]
        tags = [
            {"id": r["id"], "name": r["name"], "color": r["color"], "count": r["cnt"]}
            for r in conn.execute(
                """
                SELECT t.id, t.name, t.color, COUNT(at.asset_id) AS cnt
                FROM tags t
                LEFT JOIN asset_tags at ON at.tag_id = t.id
                LEFT JOIN assets a ON a.id = at.asset_id AND a.is_deleted = 0
                GROUP BY t.id ORDER BY cnt DESC, t.name ASC
                """
            ).fetchall()
        ]
        return {
            "counts": {
                "total": counts["total"] or 0,
                "images": counts["images"] or 0,
                "videos": counts["videos"] or 0,
                "starred": counts["starred"] or 0,
                "picked": counts["picked"] or 0,
                "rejected": counts["rejected"] or 0,
                "trash": trash_count,
                "hidden": hidden_count,
            },
            "folders": folders,
            "loras": loras,
            "model_families": model_families,
            "models": models,
            "workflows": workflows,
            "versions": versions,
            "tags": tags,
        }

    # --- Tags ---
    def list_tags(self) -> List[Dict[str, Any]]:
        rows = self._conn().execute("SELECT id, name, color FROM tags ORDER BY name ASC").fetchall()
        return [dict(r) for r in rows]

    def create_or_get_tag(self, name: str, color: str = "#6366f1") -> Dict[str, Any]:
        name = name.strip()
        with self._write_lock:
            conn = self._conn()
            row = conn.execute("SELECT id, name, color FROM tags WHERE name = ?", (name,)).fetchone()
            if row:
                return dict(row)
            cur = conn.execute("INSERT INTO tags(name, color) VALUES (?, ?)", (name, color))
            conn.commit()
            return {"id": int(cur.lastrowid), "name": name, "color": color}

    def set_asset_tag(self, asset_id: int, tag_id: int, attach: bool = True) -> None:
        with self._write_lock:
            conn = self._conn()
            if attach:
                conn.execute("INSERT OR IGNORE INTO asset_tags(asset_id, tag_id) VALUES (?, ?)", (asset_id, tag_id))
            else:
                conn.execute("DELETE FROM asset_tags WHERE asset_id = ? AND tag_id = ?", (asset_id, tag_id))
            conn.commit()

    # --- LoRA Matrix ---
    def get_lora_matrix(self) -> List[Dict[str, Any]]:
        conn = self._conn()
        rows = conn.execute(
            """
            SELECT al.lora_name,
                   COUNT(DISTINCT a.id) AS total_count,
                   SUM(CASE WHEN a.rating >= 4 OR a.flag = 'pick' THEN 1 ELSE 0 END) AS pick_count,
                   ROUND(AVG(al.strength_model), 2) AS avg_strength,
                   ROUND(MIN(al.strength_model), 2) AS min_strength,
                   ROUND(MAX(al.strength_model), 2) AS max_strength,
                   MAX(a.created_at) AS last_used
            FROM asset_loras al
            JOIN assets a ON a.id = al.asset_id
            WHERE a.is_deleted = 0 AND al.enabled = 1
            GROUP BY al.lora_name
            ORDER BY total_count DESC
            LIMIT 120
            """
        ).fetchall()

        result = []
        for r in rows:
            samples = conn.execute(
                """
                SELECT a.id, a.filename, a.thumb_name, a.media_type, a.rating, a.flag, al.strength_model
                FROM asset_loras al JOIN assets a ON a.id = al.asset_id
                WHERE a.is_deleted = 0 AND al.lora_name = ? AND al.enabled = 1
                ORDER BY a.rating DESC, a.created_at DESC
                LIMIT 6
                """,
                (r["lora_name"],),
            ).fetchall()
            result.append(
                {
                    "lora_name": r["lora_name"],
                    "total_count": r["total_count"],
                    "pick_count": r["pick_count"] or 0,
                    "pick_rate": round((r["pick_count"] or 0) * 100.0 / max(1, r["total_count"]), 1),
                    "avg_strength": r["avg_strength"],
                    "min_strength": r["min_strength"],
                    "max_strength": r["max_strength"],
                    "last_used": r["last_used"],
                    "samples": [
                        {
                            "id": s["id"],
                            "filename": s["filename"],
                            "media_type": s["media_type"],
                            "rating": s["rating"],
                            "flag": s["flag"],
                            "strength_model": s["strength_model"],
                            "thumb_url": f"/api/thumbs/{s['thumb_name']}" if s["thumb_name"] else f"/api/thumb-by-id/{s['id']}",
                        }
                        for s in samples
                    ],
                }
            )
        return result

    # --- Prompt Snippets ---
    def list_snippets(self) -> List[Dict[str, Any]]:
        rows = self._conn().execute("SELECT * FROM snippets ORDER BY updated_at DESC").fetchall()
        return [dict(r) for r in rows]

    def create_snippet(self, title: str, category: str, content: str, notes: str = "") -> Dict[str, Any]:
        now = time.time()
        with self._write_lock:
            conn = self._conn()
            cur = conn.execute(
                "INSERT INTO snippets(title, category, content, notes, created_at, updated_at) VALUES (?,?,?,?,?,?)",
                (title.strip(), category.strip() or "通用", content, notes, now, now),
            )
            conn.commit()
            return dict(conn.execute("SELECT * FROM snippets WHERE id = ?", (cur.lastrowid,)).fetchone())

    def update_snippet(self, snippet_id: int, title: str, category: str, content: str, notes: str = "") -> Optional[Dict[str, Any]]:
        with self._write_lock:
            conn = self._conn()
            conn.execute(
                "UPDATE snippets SET title=?, category=?, content=?, notes=?, updated_at=? WHERE id=?",
                (title.strip(), category.strip() or "通用", content, notes, time.time(), snippet_id),
            )
            conn.commit()
            row = conn.execute("SELECT * FROM snippets WHERE id = ?", (snippet_id,)).fetchone()
            return dict(row) if row else None

    def delete_snippet(self, snippet_id: int) -> None:
        with self._write_lock:
            conn = self._conn()
            conn.execute("DELETE FROM snippets WHERE id = ?", (snippet_id,))
            conn.commit()

    # --- Workflow Templates ---
    def list_workflow_templates(self) -> List[Dict[str, Any]]:
        conn = self._conn()
        rows = conn.execute(
            """
            WITH grouped AS (
                SELECT workflow_hash,
                       COUNT(*) AS usage_count,
                       MAX(created_at) AS last_used,
                       MAX(id) AS latest_id
                FROM assets
                WHERE is_deleted = 0 AND workflow_hash IS NOT NULL AND raw_prompt_json IS NOT NULL
                GROUP BY workflow_hash
            )
            SELECT g.workflow_hash, g.usage_count, g.last_used,
                   a.id AS sample_asset_id, a.filename, a.thumb_name, a.media_type,
                   a.workflow_name, a.model_family, a.base_model, a.folder,
                   COALESCE(wa.custom_name, '') AS custom_name
            FROM grouped g
            JOIN assets a ON a.id = g.latest_id
            LEFT JOIN workflow_aliases wa ON wa.workflow_hash = g.workflow_hash
            ORDER BY g.last_used DESC
            LIMIT 80
            """
        ).fetchall()
        return [
            {
                "workflow_hash": r["workflow_hash"],
                "name": r["custom_name"] or r["workflow_name"] or f"Workflow #{r['workflow_hash'][:6]}",
                "custom_name": r["custom_name"],
                "usage_count": r["usage_count"],
                "last_used": r["last_used"],
                "sample_asset_id": r["sample_asset_id"],
                "filename": r["filename"],
                "media_type": r["media_type"],
                "model_family": r["model_family"],
                "base_model": r["base_model"],
                "folder": r["folder"],
                "thumb_url": f"/api/thumbs/{r['thumb_name']}" if r["thumb_name"] else f"/api/thumb-by-id/{r['sample_asset_id']}",
            }
            for r in rows
        ]

    def get_workflow_template(self, wf_hash: str) -> Optional[Dict[str, Any]]:
        conn = self._conn()
        r = conn.execute(
            """
            SELECT a.id, a.workflow_hash, a.workflow_name, a.raw_prompt_json, a.raw_workflow_json,
                   COALESCE(wa.custom_name, '') AS custom_name
            FROM assets a
            LEFT JOIN workflow_aliases wa ON wa.workflow_hash = a.workflow_hash
            WHERE a.is_deleted = 0 AND a.workflow_hash = ? AND a.raw_prompt_json IS NOT NULL
            ORDER BY a.created_at DESC, a.id DESC
            LIMIT 1
            """,
            (wf_hash,),
        ).fetchone()
        if not r:
            return None
        prompt_json = json.loads(r["raw_prompt_json"])
        workflow_json = json.loads(r["raw_workflow_json"]) if r["raw_workflow_json"] else None
        # Build UI node titles map
        ui_titles: Dict[str, str] = {}
        if isinstance(workflow_json, dict):
            for n in workflow_json.get("nodes") or []:
                if isinstance(n, dict) and "id" in n and n.get("title"):
                    ui_titles[str(n["id"])] = str(n["title"])
        return {
            "workflow_hash": r["workflow_hash"],
            "name": r["custom_name"] or r["workflow_name"] or f"Workflow #{wf_hash[:6]}",
            "sample_asset_id": r["id"],
            "prompt_json": prompt_json,
            "workflow_json": workflow_json,
            "ui_titles": ui_titles,
        }

    def rename_workflow_template(self, wf_hash: str, custom_name: str) -> None:
        with self._write_lock:
            conn = self._conn()
            conn.execute(
                """
                INSERT INTO workflow_aliases(workflow_hash, custom_name, updated_at)
                VALUES (?, ?, ?)
                ON CONFLICT(workflow_hash) DO UPDATE SET custom_name=excluded.custom_name, updated_at=excluded.updated_at
                """,
                (wf_hash, custom_name.strip(), time.time()),
            )
            conn.commit()

    # --- Settings ---
    def get_setting(self, key: str, default: Any = None) -> Any:
        row = self._conn().execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
        if not row:
            return default
        try:
            return json.loads(row["value"])
        except Exception:
            return row["value"]

    def set_setting(self, key: str, value: Any) -> None:
        with self._write_lock:
            conn = self._conn()
            conn.execute(
                """
                INSERT INTO settings(key, value) VALUES (?, ?)
                ON CONFLICT(key) DO UPDATE SET value=excluded.value
                """,
                (key, json.dumps(value, ensure_ascii=False)),
            )
            conn.commit()

    # --- Workflow Files Cache ---
    def get_workflow_files_cache(self) -> Dict[str, Dict[str, Any]]:
        rows = self._conn().execute("SELECT * FROM workflow_files_cache").fetchall()
        return {r["path"]: dict(r) for r in rows}

    def sync_workflow_files_cache(self, upserts: List[Dict[str, Any]], delete_paths: List[str]) -> None:
        if not upserts and not delete_paths:
            return
        with self._write_lock:
            conn = self._conn()
            if upserts:
                conn.executemany(
                    """
                    INSERT INTO workflow_files_cache(
                        path, base_dir, rel_path, folder, name, file_size, mtime, mtime_ns, format, node_count
                    ) VALUES (?,?,?,?,?,?,?,?,?,?)
                    ON CONFLICT(path) DO UPDATE SET
                        base_dir=excluded.base_dir,
                        rel_path=excluded.rel_path,
                        folder=excluded.folder,
                        name=excluded.name,
                        file_size=excluded.file_size,
                        mtime=excluded.mtime,
                        mtime_ns=excluded.mtime_ns,
                        format=excluded.format,
                        node_count=excluded.node_count
                    """,
                    [
                        (
                            u["path"],
                            u["base_dir"],
                            u["rel_path"],
                            u["folder"],
                            u["name"],
                            u["file_size"],
                            u["mtime"],
                            u["mtime_ns"],
                            u["format"],
                            u["node_count"],
                        )
                        for u in upserts
                    ],
                )
            if delete_paths:
                for i in range(0, len(delete_paths), 400):
                    chunk = delete_paths[i : i + 400]
                    q = ",".join("?" for _ in chunk)
                    conn.execute(f"DELETE FROM workflow_files_cache WHERE path IN ({q})", chunk)
            conn.commit()

    def purge_assets(self, asset_ids: List[int]) -> List[str]:
        """Permanently delete DB rows and return their rel_paths for disk deletion."""
        if not asset_ids:
            return []
        with self._write_lock:
            conn = self._conn()
            q = ",".join("?" for _ in asset_ids)
            rows = conn.execute(f"SELECT rel_path FROM assets WHERE id IN ({q})", asset_ids).fetchall()
            paths = [r["rel_path"] for r in rows]
            conn.execute(f"DELETE FROM assets WHERE id IN ({q})", asset_ids)
            conn.commit()
            return paths

    def delete_folder_records(self, folder: str) -> int:
        """Remove all DB asset rows belonging to folder or its subfolders."""
        folder = folder.strip("/")
        if not folder:
            return 0
        with self._write_lock:
            conn = self._conn()
            cur = conn.execute(
                "DELETE FROM assets WHERE folder = ? OR folder LIKE ?",
                (folder, f"{folder}/%"),
            )
            conn.commit()
            return cur.rowcount

    def rename_folder_records(self, old_folder: str, new_folder: str) -> int:
        """Update folder and rel_path prefixes in DB after renaming a directory on disk."""
        old_f = old_folder.strip("/")
        new_f = new_folder.strip("/")
        if not old_f or not new_f or old_f == new_f:
            return 0
        with self._write_lock:
            conn = self._conn()
            rows = conn.execute(
                "SELECT id, rel_path, folder FROM assets WHERE folder = ? OR folder LIKE ?",
                (old_f, f"{old_f}/%"),
            ).fetchall()
            updates = []
            for r in rows:
                f = r["folder"]
                rp = r["rel_path"]
                nf = new_f if f == old_f else new_f + f[len(old_f):]
                nrp = new_f + rp[len(old_f):] if rp.startswith(old_f + "/") else rp
                updates.append((nrp, nf, r["id"]))
            if updates:
                conn.executemany("UPDATE assets SET rel_path = ?, folder = ? WHERE id = ?", updates)
                conn.commit()
            return len(updates)
