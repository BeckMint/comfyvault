import ctypes
import hashlib
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

from watchdog.events import FileSystemEventHandler
from watchdog.observers import Observer

from .comfy_history import GitVersionTimeline
from .config import MEDIA_EXTS, OUTPUT_DIR
from .db import VaultDB
from .parser import extract_media_info_and_metadata, parse_comfy_metadata
from .thumbnails import ensure_thumbnail


def _is_junction_or_symlink(path: Path) -> bool:
    """Detect symlinks and Windows NTFS Directory Junctions (FILE_ATTRIBUTE_REPARSE_POINT)."""
    try:
        if path.is_symlink():
            return True
        if os.name == "nt":
            attrs = ctypes.windll.kernel32.GetFileAttributesW(str(path))
            if attrs != -1 and (attrs & 0x0400):  # FILE_ATTRIBUTE_REPARSE_POINT
                return True
    except Exception:
        pass
    return False


class _OutputEventHandler(FileSystemEventHandler):
    def __init__(self, on_file: Callable[[Path], None]):
        super().__init__()
        self.on_file = on_file

    def on_created(self, event):
        if not event.is_directory:
            self._handle(event.src_path)

    def on_modified(self, event):
        if not event.is_directory:
            self._handle(event.src_path)

    def on_moved(self, event):
        if not event.is_directory:
            self._handle(event.dest_path)

    def _handle(self, path_str: str):
        p = Path(path_str)
        if p.suffix.lower() in MEDIA_EXTS:
            self.on_file(p)


class AssetScanner:
    def __init__(self, db: VaultDB, notify_cb: Optional[Callable[[Dict[str, Any]], None]] = None):
        self.db = db
        self.notify_cb = notify_cb
        self.pool = ThreadPoolExecutor(max_workers=6, thread_name_prefix="vault-scan")
        self.version_timeline = GitVersionTimeline()
        self._scan_lock = threading.Lock()
        self.status: Dict[str, Any] = {
            "scanning": False,
            "scanned": 0,
            "total": 0,
            "added": 0,
            "last_scan_at": 0.0,
        }
        self.thumb_status: Dict[str, Any] = {
            "running": False,
            "done": 0,
            "total": 0,
        }
        self._thumb_lock = threading.Lock()
        self._observer: Optional[Observer] = None
        self._pending_files: Dict[str, float] = {}
        self._pending_lock = threading.Lock()
        self._debounce_thread: Optional[threading.Thread] = None
        self._stop_event = threading.Event()

    def _emit(self, event_type: str, payload: Dict[str, Any]) -> None:
        if self.notify_cb:
            try:
                self.notify_cb({"type": event_type, "data": payload})
            except Exception:
                pass

    def get_output_roots(self) -> List[Tuple[str, Path]]:
        """Return list of (prefix, resolved_dir) for all configured output/gallery directories.
        The primary ComfyUI OUTPUT_DIR always uses prefix '' for full DB backward compatibility.
        Additional gallery directories use '@<folder_name>' as virtual root prefix.
        """
        raw_dirs = self.db.get_setting("output_dirs", [str(OUTPUT_DIR)])
        if not isinstance(raw_dirs, list) or not raw_dirs:
            raw_dirs = [str(OUTPUT_DIR)]

        default_resolved = OUTPUT_DIR.resolve()
        roots: List[Tuple[str, Path]] = []
        seen_paths = set()
        used_prefixes = {""}

        for d in raw_dirs:
            s = str(d).strip()
            if not s:
                continue
            try:
                p = Path(s).resolve()
            except Exception:
                continue
            if not p.exists() or not p.is_dir():
                continue
            key = str(p).lower()
            if key in seen_paths:
                continue
            seen_paths.add(key)

            if key == str(default_resolved).lower():
                roots.append(("", p))
            else:
                base_label = p.name or p.drive.rstrip(":\\") or "album"
                prefix = f"@{base_label}"
                if prefix.lower() in used_prefixes:
                    h = hashlib.md5(key.encode("utf-8")).hexdigest()[:4]
                    prefix = f"@{base_label}_{h}"
                used_prefixes.add(prefix.lower())
                roots.append((prefix, p))

        if not roots and default_resolved.exists():
            roots.append(("", default_resolved))
        return roots

    def resolve_asset_path(self, rel_path: str) -> Path:
        norm = (rel_path or "").replace("\\", "/").lstrip("/")
        if norm.startswith("@"):
            parts = norm.split("/", 1)
            prefix = parts[0]
            rest = parts[1] if len(parts) > 1 else ""
            for rpfx, root in self.get_output_roots():
                if rpfx.lower() == prefix.lower():
                    return (root / rest) if rest else root
        return OUTPUT_DIR / norm

    def start_watcher(self) -> None:
        roots = self.get_output_roots()
        if not roots:
            return
        handler = _OutputEventHandler(self._queue_watched_file)
        obs = Observer()
        for _prefix, root in roots:
            try:
                obs.schedule(handler, str(root), recursive=True)
            except Exception:
                pass
        obs.daemon = True
        obs.start()
        self._observer = obs

        if not self._debounce_thread or not self._debounce_thread.is_alive():
            self._stop_event.clear()
            self._debounce_thread = threading.Thread(target=self._debounce_loop, daemon=True, name="vault-watch-debounce")
            self._debounce_thread.start()

    def reload_watchers(self) -> None:
        if self._observer:
            try:
                self._observer.stop()
                self._observer.join(timeout=2)
            except Exception:
                pass
            self._observer = None
        self.start_watcher()

    def stop_watcher(self) -> None:
        self._stop_event.set()
        if self._observer:
            try:
                self._observer.stop()
                self._observer.join(timeout=2)
            except Exception:
                pass

    def _queue_watched_file(self, path: Path) -> None:
        with self._pending_lock:
            self._pending_files[str(path)] = time.time()

    def _debounce_loop(self) -> None:
        while not self._stop_event.is_set():
            time.sleep(0.5)
            now = time.time()
            ready = []
            with self._pending_lock:
                for p_str, ts in list(self._pending_files.items()):
                    if now - ts >= 0.8:
                        ready.append(Path(p_str))
                        del self._pending_files[p_str]
            for p in ready:
                if p.exists():
                    try:
                        asset_id = self.index_file(p, generate_thumb=True)
                        if asset_id:
                            self._emit("asset_indexed", {"id": asset_id, "rel_path": self._to_rel(p)})
                    except Exception:
                        pass

    def _to_rel(self, file_path: Path) -> str:
        resolved = file_path.resolve()
        res_low = str(resolved).lower()
        # Sort longest root first so nested dirs match most specific root
        roots = sorted(self.get_output_roots(), key=lambda x: len(str(x[1])), reverse=True)
        for prefix, root in roots:
            root_low = str(root).lower()
            if res_low == root_low or res_low.startswith(root_low + os.sep):
                rel = str(resolved.relative_to(root)).replace("\\", "/")
                return f"{prefix}/{rel}" if prefix else rel
        rel = file_path.relative_to(OUTPUT_DIR)
        return str(rel).replace("\\", "/")

    def build_record(
        self,
        file_path: Path,
        *,
        overrides: Optional[Dict[str, Any]] = None,
        generate_thumb: bool = True,
    ) -> Optional[Dict[str, Any]]:
        if not file_path.exists() or not file_path.is_file():
            return None
        ext = file_path.suffix.lower()
        if ext not in MEDIA_EXTS:
            return None

        try:
            st = file_path.stat()
        except OSError:
            return None

        rel_path = self._to_rel(file_path)
        folder = str(Path(rel_path).parent).replace("\\", "/")
        if folder == ".":
            folder = ""

        info = extract_media_info_and_metadata(file_path)
        ov = overrides or {}
        prompt_json = ov.get("prompt_json") or info.get("prompt_json")
        workflow_json = ov.get("workflow_json") or info.get("workflow_json")
        parsed = parse_comfy_metadata(prompt_json, workflow_json, info.get("raw_parameters"))

        # Backfill historical ComfyUI version from local git reflog if not provided live
        comfy_version = ov.get("comfy_version") or self.version_timeline.resolve(st.st_mtime)

        thumb_name = None
        if generate_thumb:
            thumb_name = ensure_thumbnail(file_path, rel_path, st.st_mtime_ns, st.st_size)

        return {
            "rel_path": rel_path,
            "folder": folder,
            "filename": file_path.name,
            "media_type": info["media_type"],
            "ext": ext,
            "file_size": st.st_size,
            "mtime_ns": st.st_mtime_ns,
            "created_at": st.st_mtime,
            "width": info["width"],
            "height": info["height"],
            "duration": info["duration"],
            "fps": info["fps"],
            "thumb_name": thumb_name,
            "comfy_version": comfy_version,
            "gen_duration_sec": ov.get("gen_duration_sec"),
            "parent_id": ov.get("parent_id"),
            "workflow_hash": parsed["workflow_hash"],
            "workflow_name": parsed["workflow_name"],
            "recipe_hash": parsed["recipe_hash"],
            "base_model": parsed["base_model"],
            "model_family": parsed["model_family"],
            "primary_prompt": parsed["primary_prompt"],
            "all_prompts_text": parsed["all_prompts_text"],
            "prompts": parsed["prompts"],
            "models": parsed["models"],
            "loras": parsed["loras"],
            "params": parsed["params"],
            "seed_targets": parsed["seed_targets"],
            "param_targets": parsed["param_targets"],
            "raw_prompt_json": prompt_json,
            "raw_workflow_json": workflow_json,
        }

    def index_file(
        self,
        file_path: Path,
        *,
        overrides: Optional[Dict[str, Any]] = None,
        generate_thumb: bool = True,
    ) -> Optional[int]:
        rec = self.build_record(file_path, overrides=overrides, generate_thumb=generate_thumb)
        if not rec:
            return None
        return self.db.upsert_asset(rec)

    def trigger_scan_background(self, force_reparse: bool = False) -> bool:
        if self.status["scanning"]:
            return False
        t = threading.Thread(
            target=self.scan_all,
            kwargs={"force_reparse": force_reparse},
            daemon=True,
            name="vault-full-scan",
        )
        t.start()
        return True

    def scan_all(self, force_reparse: bool = False) -> Dict[str, Any]:
        if not self._scan_lock.acquire(blocking=False):
            return self.status
        try:
            self.status.update({"scanning": True, "scanned": 0, "total": 0, "added": 0})
            self._emit("scan_progress", dict(self.status))

            roots = self.get_output_roots()
            if not roots:
                self.status.update({"scanning": False, "last_scan_at": time.time()})
                return self.status

            existing_map = self.db.get_existing_file_map()
            discovered_files = []
            seen_rel_paths = set()

            for prefix, root_dir in roots:
                for root, dirs, files in os.walk(root_dir):
                    root_p = Path(root)
                    # Skip directory junctions & symlinks (e.g. realgirl/aki_safe_v2 -> aki) to prevent duplicate entries!
                    dirs[:] = [d for d in dirs if not _is_junction_or_symlink(root_p / d)]
                    for fn in files:
                        ext = os.path.splitext(fn)[1].lower()
                        if ext not in MEDIA_EXTS:
                            continue
                        fp = root_p / fn
                        try:
                            sub_rel = str(fp.relative_to(root_dir)).replace("\\", "/")
                            rel = f"{prefix}/{sub_rel}" if prefix else sub_rel
                            seen_rel_paths.add(rel)
                            st = fp.stat()
                        except OSError:
                            continue
                        old = existing_map.get(rel)
                        if not force_reparse and old is not None:
                            _id, old_mtime, old_size, _old_thumb = old
                            if old_mtime == st.st_mtime_ns and old_size == st.st_size:
                                continue
                        discovered_files.append(fp)

            total = len(discovered_files)
            self.status["total"] = total
            self._emit("scan_progress", dict(self.status))

            done = 0
            added = 0
            last_emit = time.time()

            # Phase 1: Parallel read-only metadata parsing + batched SQLite commits (zero lock contention!)
            def _parse_only(path: Path) -> Optional[Dict[str, Any]]:
                try:
                    return self.build_record(path, generate_thumb=False)
                except Exception:
                    return None

            if discovered_files:
                chunk_size = 100
                for start in range(0, total, chunk_size):
                    chunk = discovered_files[start : start + chunk_size]
                    futures = [self.pool.submit(_parse_only, fp) for fp in chunk]
                    batch_records = []
                    for fut in as_completed(futures):
                        done += 1
                        try:
                            rec = fut.result()
                            if rec is not None:
                                batch_records.append(rec)
                        except Exception:
                            pass
                    if batch_records:
                        self.db.upsert_assets_batch(batch_records)
                        added += len(batch_records)
                    self.status["scanned"] = done
                    self.status["added"] = added
                    self._emit("scan_progress", dict(self.status))

            removed = self.db.remove_missing_paths(seen_rel_paths)
            self.status.update(
                {
                    "scanning": False,
                    "scanned": done,
                    "total": total,
                    "added": added,
                    "removed": removed,
                    "last_scan_at": time.time(),
                }
            )
            self._emit("scan_done", dict(self.status))
            # Automatically kick off low-priority thumbnail pre-warming after scan
            self.trigger_thumb_prewarm()
            return self.status
        finally:
            self._scan_lock.release()

    def trigger_thumb_prewarm(self) -> bool:
        if self.thumb_status["running"]:
            return False
        t = threading.Thread(target=self._prewarm_thumbs_worker, daemon=True, name="vault-thumb-prewarm")
        t.start()
        return True

    def _prewarm_thumbs_worker(self) -> None:
        if not self._thumb_lock.acquire(blocking=False):
            return
        try:
            missing = self.db.get_assets_missing_thumbs()
            total = len(missing)
            if total == 0:
                self.thumb_status.update({"running": False, "done": 0, "total": 0})
                return

            self.thumb_status.update({"running": True, "done": 0, "total": total})
            self._emit("thumb_progress", dict(self.thumb_status))

            done = 0
            last_emit = time.time()

            def _gen_one(row: Dict[str, Any]) -> None:
                if self._stop_event.is_set():
                    return
                fp = self.resolve_asset_path(row["rel_path"])
                if not fp.exists():
                    return
                tname = ensure_thumbnail(fp, row["rel_path"], row["mtime_ns"], row["file_size"])
                if tname:
                    self.db.update_thumb(row["id"], tname)

            # Low-concurrency pool (2 workers) so UI & ComfyUI remain completely responsive
            with ThreadPoolExecutor(max_workers=2, thread_name_prefix="vault-thumb") as tpool:
                chunk_size = 50
                for start in range(0, total, chunk_size):
                    if self._stop_event.is_set():
                        break
                    chunk = missing[start : start + chunk_size]
                    futs = [tpool.submit(_gen_one, r) for r in chunk]
                    for fut in as_completed(futs):
                        done += 1
                        try:
                            fut.result()
                        except Exception:
                            pass
                        now = time.time()
                        if now - last_emit >= 0.6 or done == total:
                            self.thumb_status["done"] = done
                            self._emit("thumb_progress", dict(self.thumb_status))
                            last_emit = now

            self.thumb_status.update({"running": False, "done": done, "total": total})
            self._emit("thumb_done", dict(self.thumb_status))
        finally:
            self._thumb_lock.release()
