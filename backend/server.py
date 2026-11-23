import asyncio
import ctypes
import json
import os
from pathlib import Path
from typing import Any, Dict, Set

import aiohttp
from aiohttp import WSMsgType, web

from .comfy_bridge import ComfyBridge
from .config import COMFY_HTTP_URL, COMFY_PORT, COMFY_ROOT, FRONTEND_DIST, OUTPUT_DIR, PORTABLE_ROOT, THUMBS_DIR, VAULT_HOST, VAULT_PORT, ensure_dirs
from .db import VaultDB
from .scanner import AssetScanner
from .thumbnails import ensure_thumbnail
from .workflow_loader import (
    DEFAULT_WORKFLOW_DIRS,
    extract_class_types_from_raw,
    get_comfy_object_info_for_types,
    load_and_convert_workflow_file,
    save_edits_to_workflow_file,
    scan_workflow_dirs,
)


def _send_to_recycle_bin(file_path: Path) -> bool:
    """Safely send a file to the Windows Recycle Bin; fallback to unlink."""
    try:
        from ctypes import wintypes

        class SHFILEOPSTRUCTW(ctypes.Structure):
            _fields_ = [
                ("hwnd", wintypes.HWND),
                ("wFunc", wintypes.UINT),
                ("pFrom", wintypes.LPCWSTR),
                ("pTo", wintypes.LPCWSTR),
                ("fFlags", ctypes.c_uint16),
                ("fAnyOperationsAborted", wintypes.BOOL),
                ("hNameMappings", wintypes.LPVOID),
                ("lpszProgressTitle", wintypes.LPCWSTR),
            ]

        FO_DELETE = 0x0003
        FOF_ALLOWUNDO = 0x0040
        FOF_NOCONFIRMATION = 0x0010
        FOF_SILENT = 0x0004

        op = SHFILEOPSTRUCTW()
        op.wFunc = FO_DELETE
        op.pFrom = str(file_path) + "\0\0"
        op.fFlags = FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_SILENT
        res = ctypes.windll.shell32.SHFileOperationW(ctypes.byref(op))
        return res == 0
    except Exception:
        try:
            file_path.unlink(missing_ok=True)
            return True
        except Exception:
            return False


class VaultApp:
    def __init__(self) -> None:
        ensure_dirs()
        self.db = VaultDB()
        self.ws_clients: Set[web.WebSocketResponse] = set()
        self.loop: asyncio.AbstractEventLoop | None = None
        self.scanner = AssetScanner(self.db, notify_cb=self.broadcast_sync)
        self.bridge = ComfyBridge(self.db, self.scanner, notify_cb=self.broadcast_sync)
        self.thumb_sem = asyncio.Semaphore(3)

    def broadcast_sync(self, message: Dict[str, Any]) -> None:
        if not self.loop or self.loop.is_closed():
            return
        asyncio.run_coroutine_threadsafe(self.broadcast(message), self.loop)

    async def broadcast(self, message: Dict[str, Any]) -> None:
        if not self.ws_clients:
            return
        raw = json.dumps(message, ensure_ascii=False)
        dead = []
        for ws in list(self.ws_clients):
            try:
                await ws.send_str(raw)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.ws_clients.discard(ws)

    # --- Handlers ---
    async def handle_health(self, request: web.Request) -> web.Response:
        return web.json_response(
            {
                "ok": True,
                "comfy_status": self.bridge.state,
                "scan_status": self.scanner.status,
                "thumb_status": self.scanner.thumb_status,
                "output_dir": str(OUTPUT_DIR),
            }
        )

    async def handle_facets(self, request: web.Request) -> web.Response:
        data = await asyncio.to_thread(self.db.get_sidebar_facets)
        return web.json_response(data)

    async def handle_list_assets(self, request: web.Request) -> web.Response:
        q = request.query
        folder = q.get("folder")
        folder_exact = q.get("folder_exact") in ("1", "true", "yes")
        media_type = q.get("media_type") or None
        search = q.get("search") or None
        lora = q.get("lora") or None
        base_model = q.get("base_model") or None
        model_family = q.get("model_family") or None
        workflow_hash = q.get("workflow_hash") or None
        recipe_hash = q.get("recipe_hash") or None
        tag_id = int(q["tag_id"]) if q.get("tag_id") and q["tag_id"].isdigit() else None
        min_rating = int(q["min_rating"]) if q.get("min_rating") and q["min_rating"].isdigit() else None
        flag = q.get("flag") or None
        comfy_version = q.get("comfy_version") or None
        show_deleted = q.get("show_deleted") in ("1", "true")
        show_hidden = q.get("show_hidden") in ("1", "true")
        collapse_recipes = q.get("collapse_recipes") in ("1", "true")
        sort = q.get("sort", "newest")
        limit = max(1, min(1000, int(q.get("limit", "250"))))
        offset = max(0, int(q.get("offset", "0")))

        data = await asyncio.to_thread(
            self.db.query_assets,
            folder=folder,
            folder_exact=folder_exact,
            media_type=media_type,
            search=search,
            lora=lora,
            base_model=base_model,
            model_family=model_family,
            workflow_hash=workflow_hash,
            recipe_hash=recipe_hash,
            tag_id=tag_id,
            min_rating=min_rating,
            flag=flag,
            comfy_version=comfy_version,
            show_deleted=show_deleted,
            show_hidden=show_hidden,
            collapse_recipes=collapse_recipes,
            sort=sort,
            limit=limit,
            offset=offset,
        )
        return web.json_response(data)

    async def handle_asset_detail(self, request: web.Request) -> web.Response:
        asset_id = int(request.match_info["id"])
        detail = await asyncio.to_thread(self.db.get_asset_detail, asset_id)
        if not detail:
            return web.json_response({"error": "Not found"}, status=404)
        return web.json_response(detail)

    async def handle_patch_asset(self, request: web.Request) -> web.Response:
        asset_id = int(request.match_info["id"])
        body = await request.json()
        await asyncio.to_thread(
            self.db.update_asset_meta,
            asset_id,
            rating=body.get("rating"),
            flag=body.get("flag"),
            notes=body.get("notes"),
            is_deleted=body.get("is_deleted"),
            is_hidden=body.get("is_hidden"),
        )
        detail = await asyncio.to_thread(self.db.get_asset_detail, asset_id)
        return web.json_response(detail or {"ok": True})

    async def handle_batch_trash(self, request: web.Request) -> web.Response:
        body = await request.json()
        ids = [int(x) for x in body.get("ids") or []]
        is_deleted = 1 if body.get("is_deleted", True) else 0
        for aid in ids:
            await asyncio.to_thread(self.db.update_asset_meta, aid, is_deleted=is_deleted)
        return web.json_response({"ok": True, "count": len(ids)})

    async def handle_purge_assets(self, request: web.Request) -> web.Response:
        body = await request.json()
        ids = [int(x) for x in body.get("ids") or []]
        delete_disk = bool(body.get("delete_disk", True))
        rel_paths = await asyncio.to_thread(self.db.purge_assets, ids)
        deleted_files = 0
        if delete_disk:
            for rp in rel_paths:
                fp = self.scanner.resolve_asset_path(rp)
                if fp.exists():
                    if await asyncio.to_thread(_send_to_recycle_bin, fp):
                        deleted_files += 1
        return web.json_response({"ok": True, "purged": len(rel_paths), "deleted_files": deleted_files})

    async def handle_raw_json(self, request: web.Request) -> web.Response:
        asset_id = int(request.match_info["id"])
        kind = request.match_info["kind"]
        raw_p, raw_w = await asyncio.to_thread(self.db.get_raw_json, asset_id)
        target = raw_p if kind == "prompt" else raw_w
        if not target:
            return web.json_response({"error": "No metadata available"}, status=404)
        return web.json_response(target)

    async def handle_save_recipe_note(self, request: web.Request) -> web.Response:
        rhash = request.match_info["recipe_hash"]
        body = await request.json()
        await asyncio.to_thread(self.db.save_recipe_note, rhash, body.get("title", ""), body.get("notes", ""))
        return web.json_response({"ok": True})

    async def handle_create_tag(self, request: web.Request) -> web.Response:
        body = await request.json()
        name = (body.get("name") or "").strip()
        if not name:
            return web.json_response({"error": "Tag name required"}, status=400)
        tag = await asyncio.to_thread(self.db.create_or_get_tag, name, body.get("color", "#6366f1"))
        return web.json_response(tag)

    async def handle_attach_tag(self, request: web.Request) -> web.Response:
        asset_id = int(request.match_info["id"])
        body = await request.json()
        if body.get("tag_id"):
            tag_id = int(body["tag_id"])
            tag = None
        else:
            name = (body.get("name") or "").strip()
            if not name:
                return web.json_response({"error": "Tag name required"}, status=400)
            tag = await asyncio.to_thread(self.db.create_or_get_tag, name, body.get("color", "#6366f1"))
            tag_id = tag["id"]
        await asyncio.to_thread(self.db.set_asset_tag, asset_id, tag_id, True)
        return web.json_response({"ok": True, "tag": tag})

    async def handle_detach_tag(self, request: web.Request) -> web.Response:
        asset_id = int(request.match_info["id"])
        tag_id = int(request.match_info["tag_id"])
        await asyncio.to_thread(self.db.set_asset_tag, asset_id, tag_id, False)
        return web.json_response({"ok": True})

    async def handle_reroll(self, request: web.Request) -> web.Response:
        asset_id = int(request.match_info["id"])
        body = await request.json() if request.can_read_body else {}
        batch_count = int(body.get("batch_count", 1))
        try:
            pids = await self.bridge.reroll_asset(asset_id, batch_count=batch_count)
            return web.json_response({"ok": True, "prompt_ids": pids})
        except Exception as e:
            return web.json_response({"error": str(e)}, status=400)

    async def handle_remix_context(self, request: web.Request) -> web.Response:
        asset_id = int(request.match_info["id"])
        raw_p, raw_w = await asyncio.to_thread(self.db.get_raw_json, asset_id)
        if not raw_p:
            return web.json_response({"error": "该资源缺少 API Prompt 元数据"}, status=404)
        ui_titles: Dict[str, str] = {}
        if isinstance(raw_w, dict):
            for n in raw_w.get("nodes") or []:
                if isinstance(n, dict) and "id" in n and n.get("title"):
                    ui_titles[str(n["id"])] = str(n["title"])
        ctypes = extract_class_types_from_raw(raw_p)
        obj_info = await get_comfy_object_info_for_types(ctypes)
        field_options: Dict[str, Dict[str, Any]] = {}
        from .workflow_loader import _is_widget_spec

        for nid, node in raw_p.items():
            if not isinstance(node, dict):
                continue
            ctype = node.get("class_type", "")
            meta_t = (node.get("_meta") or {}).get("title")
            if meta_t:
                ui_titles.setdefault(str(nid), str(meta_t))
            info = obj_info.get(ctype) or {}
            inp_defs = {**(info.get("input", {}).get("required") or {}), **(info.get("input", {}).get("optional") or {})}
            for k, spec in inp_defs.items():
                is_w, choices, _ = _is_widget_spec(spec)
                if is_w and choices:
                    field_options.setdefault(str(nid), {})[k] = choices

        return web.json_response(
            {
                "prompt_json": raw_p,
                "ui_titles": ui_titles,
                "field_options": field_options,
            }
        )

    async def handle_remix(self, request: web.Request) -> web.Response:
        asset_id = int(request.match_info["id"])
        body = await request.json()
        try:
            pids = await self.bridge.remix_asset(
                asset_id,
                prompt_json_override=body.get("prompt_json"),
                prompt_edits=body.get("prompt_edits"),
                lora_edits=body.get("lora_edits"),
                param_edits=body.get("param_edits"),
                randomize_seed=bool(body.get("randomize_seed", True)),
                batch_count=int(body.get("batch_count", 1)),
            )
            return web.json_response({"ok": True, "prompt_ids": pids})
        except Exception as e:
            return web.json_response({"error": str(e)}, status=400)

    async def handle_save_asset_prompt(self, request: web.Request) -> web.Response:
        asset_id = int(request.match_info["id"])
        body = await request.json()
        edited_prompt = body.get("prompt_json")
        if not isinstance(edited_prompt, dict):
            return web.json_response({"error": "缺少参数数据"}, status=400)
        _raw_p, raw_w = await asyncio.to_thread(self.db.get_raw_json, asset_id)
        try:
            from .parser import parse_comfy_metadata

            parsed = parse_comfy_metadata(edited_prompt, raw_w)
            ok = await asyncio.to_thread(self.db.update_asset_prompt, asset_id, edited_prompt, parsed)
            if not ok:
                return web.json_response({"error": "未找到该资源"}, status=404)
            return web.json_response({"ok": True})
        except Exception as e:
            return web.json_response({"error": f"保存失败: {e}"}, status=400)

    async def handle_save_remix_as_workflow(self, request: web.Request) -> web.Response:
        asset_id = int(request.match_info["id"])
        body = await request.json()
        edited_prompt = body.get("prompt_json")
        raw_name = (body.get("name") or "").strip()
        if not isinstance(edited_prompt, dict) or not raw_name:
            return web.json_response({"error": "缺少工作流名称或参数"}, status=400)
        safe_name = "".join(c for c in raw_name if c not in '/\\:*?"<>|').strip()
        if not safe_name:
            return web.json_response({"error": "文件名无效"}, status=400)
        if not safe_name.lower().endswith(".json"):
            safe_name += ".json"

        wf_dirs = await asyncio.to_thread(self.db.get_setting, "workflow_dirs", DEFAULT_WORKFLOW_DIRS)
        target_dir = Path((wf_dirs[0] if wf_dirs else DEFAULT_WORKFLOW_DIRS[0])).resolve()
        target_dir.mkdir(parents=True, exist_ok=True)
        out_path = target_dir / safe_name

        _raw_p, raw_w = await asyncio.to_thread(self.db.get_raw_json, asset_id)
        try:
            if isinstance(raw_w, dict) and isinstance(raw_w.get("nodes"), list):
                out_path.write_text(json.dumps(raw_w, ensure_ascii=False, indent=2), encoding="utf-8")
                ctypes = extract_class_types_from_raw(raw_w)
                obj_info = await get_comfy_object_info_for_types(ctypes)
                await asyncio.to_thread(save_edits_to_workflow_file, out_path, edited_prompt, obj_info)
            else:
                out_path.write_text(json.dumps(edited_prompt, ensure_ascii=False, indent=2), encoding="utf-8")
            return web.json_response({"ok": True, "path": str(out_path), "filename": safe_name})
        except Exception as e:
            return web.json_response({"error": f"保存失败: {e}"}, status=400)

    async def handle_scan(self, request: web.Request) -> web.Response:
        body = await request.json() if request.can_read_body else {}
        started = self.scanner.trigger_scan_background(force_reparse=bool(body.get("force", False)))
        return web.json_response({"started": started, "status": self.scanner.status})

    async def handle_comfy_interrupt(self, request: web.Request) -> web.Response:
        try:
            await self.bridge.interrupt_execution()
            return web.json_response({"ok": True})
        except Exception as e:
            return web.json_response({"error": str(e)}, status=400)

    def _stop_comfy_sync(self) -> int:
        import re
        import subprocess

        pids = set()
        # 1. Find PIDs listening on COMFY_PORT (8188)
        try:
            out = subprocess.check_output(
                ["netstat", "-ano"],
                text=True,
                stdin=subprocess.DEVNULL,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                timeout=5,
            )
            for m in re.finditer(rf":{COMFY_PORT}\s+.*LISTENING\s+(\d+)", out, re.IGNORECASE):
                pids.add(int(m.group(1)))
        except Exception:
            pass

        # 2. Also find python processes running ComfyUI\main.py
        try:
            out2 = subprocess.check_output(
                [
                    "powershell",
                    "-NoProfile",
                    "-Command",
                    "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*ComfyUI*main.py*' } | Select-Object -ExpandProperty ProcessId",
                ],
                text=True,
                stdin=subprocess.DEVNULL,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                timeout=5,
            )
            for line in out2.splitlines():
                if line.strip().isdigit():
                    pids.add(int(line.strip()))
        except Exception:
            pass

        killed = 0
        for pid in pids:
            try:
                subprocess.run(
                    ["taskkill", "/F", "/T", "/PID", str(pid)],
                    capture_output=True,
                    stdin=subprocess.DEVNULL,
                    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                    timeout=5,
                )
                killed += 1
            except Exception:
                pass
        return killed

    def _start_comfy_sync(self) -> None:
        import subprocess

        bat = PORTABLE_ROOT / "run_nvidia_gpu.bat"
        if not bat.exists():
            raise FileNotFoundError(f"找不到启动脚本: {bat}")
        # Launch minimized via cmd start, matching ComfyUI启动器.exe behavior
        subprocess.Popen(
            ["cmd", "/c", "start", "/min", "ComfyUI", "cmd", "/c", str(bat)],
            cwd=str(PORTABLE_ROOT),
            stdin=subprocess.DEVNULL,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )

    async def handle_comfy_control(self, request: web.Request) -> web.Response:
        body = await request.json()
        action = (body.get("action") or "").strip().lower()
        try:
            if action == "start":
                if self.bridge.state.get("online"):
                    return web.json_response({"ok": True, "message": "ComfyUI 已在运行中"})
                await asyncio.to_thread(self._start_comfy_sync)
                return web.json_response({"ok": True, "message": "正在启动 ComfyUI，请稍候..."})
            elif action == "stop":
                killed = await asyncio.to_thread(self._stop_comfy_sync)
                return web.json_response({"ok": True, "message": f"已关闭 ComfyUI（停止 {killed} 个进程）"})
            elif action == "restart":
                await asyncio.to_thread(self._stop_comfy_sync)
                await asyncio.sleep(1.2)
                await asyncio.to_thread(self._start_comfy_sync)
                return web.json_response({"ok": True, "message": "正在重启 ComfyUI，请稍候..."})
            else:
                return web.json_response({"error": f"不支持的操作: {action}"}, status=400)
        except Exception as e:
            return web.json_response({"error": str(e)}, status=500)

    async def handle_list_workflow_templates(self, request: web.Request) -> web.Response:
        items = await asyncio.to_thread(self.db.list_workflow_templates)
        return web.json_response({"items": items})

    async def handle_get_workflow_template(self, request: web.Request) -> web.Response:
        wf_hash = request.match_info["wf_hash"]
        tpl = await asyncio.to_thread(self.db.get_workflow_template, wf_hash)
        if not tpl:
            return web.json_response({"error": "工作流模板不存在"}, status=404)
        return web.json_response(tpl)

    async def handle_rename_workflow_template(self, request: web.Request) -> web.Response:
        wf_hash = request.match_info["wf_hash"]
        body = await request.json()
        await asyncio.to_thread(self.db.rename_workflow_template, wf_hash, body.get("name", ""))
        return web.json_response({"ok": True})

    async def handle_run_workflow(self, request: web.Request) -> web.Response:
        body = await request.json()
        prompt_json = body.get("prompt_json")
        if not isinstance(prompt_json, dict) or not prompt_json:
            return web.json_response({"error": "无效的 prompt_json"}, status=400)
        try:
            pids = await self.bridge.run_custom_prompt(
                prompt_json,
                body.get("workflow_json"),
                randomize_seed=bool(body.get("randomize_seed", True)),
                batch_count=int(body.get("batch_count", 1)),
            )
            return web.json_response({"ok": True, "prompt_ids": pids})
        except Exception as e:
            return web.json_response({"error": str(e)}, status=400)

    async def handle_comfy_upload_image(self, request: web.Request) -> web.Response:
        reader = await request.multipart()
        field = await reader.next()
        if not field:
            return web.json_response({"error": "未收到图片文件"}, status=400)
        filename = field.filename or "upload.png"
        data = await field.read()
        try:
            res = await self.bridge.upload_image(filename, data, field.headers.get("Content-Type", "image/png"))
            return web.json_response(res)
        except Exception as e:
            return web.json_response({"error": str(e)}, status=400)

    async def handle_comfy_input_image(self, request: web.Request) -> web.StreamResponse:
        name = (request.query.get("name") or "").replace("\\", "/").strip("/")
        if not name or ".." in name.split("/"):
            raise web.HTTPNotFound()
        input_dir = (COMFY_ROOT / "input").resolve()
        fp = (input_dir / name).resolve()
        if not str(fp).lower().startswith(str(input_dir).lower() + os.sep) or not fp.is_file():
            raise web.HTTPNotFound()
        resp = web.FileResponse(fp)
        resp.headers["Cache-Control"] = "no-cache"
        return resp

    def _get_lora_dirs(self) -> list:
        """Return ComfyUI's default loras dir plus any loras dirs configured in extra_model_paths.yaml."""
        dirs = []
        seen = set()

        def _add(p: Path) -> None:
            try:
                rp = p.resolve()
                key = str(rp).lower()
                if key not in seen and rp.exists() and rp.is_dir():
                    seen.add(key)
                    dirs.append(rp)
            except Exception:
                pass

        _add(COMFY_ROOT / "models" / "loras")
        yaml_path = COMFY_ROOT / "extra_model_paths.yaml"
        if yaml_path.exists():
            try:
                import yaml

                cfg = yaml.safe_load(yaml_path.read_text(encoding="utf-8", errors="ignore")) or {}
                if isinstance(cfg, dict):
                    for section in cfg.values():
                        if not isinstance(section, dict):
                            continue
                        base = section.get("base_path")
                        loras_val = section.get("loras")
                        if not loras_val:
                            continue
                        raw_list = str(loras_val).splitlines() if isinstance(loras_val, str) else (loras_val if isinstance(loras_val, list) else [])
                        for item in raw_list:
                            s = str(item).strip()
                            if not s:
                                continue
                            p = Path(s)
                            if not p.is_absolute() and base:
                                p = Path(str(base).strip()) / p
                            _add(p)
            except Exception:
                pass
        return dirs

    def _detect_lora_ranges_sync(self, lora_names: list) -> Dict[str, Dict[str, Any]]:
        """Auto-detect recommended [min, max] per LoRA from:
        1) Local sidecar .civitai.info / .metadata.json / .rgthree-info.json descriptions & tags (across all lora dirs)
        2) Historical usage min/max in vault.db
        """
        import re

        lora_dirs = self._get_lora_dirs()
        ranges: Dict[str, Dict[str, Any]] = {}

        # 1. Historical usage stats from vault.db
        hist_bounds: Dict[str, tuple] = {}
        try:
            rows = self.db._conn().execute(
                """
                SELECT lora_name, MIN(strength_model) AS mn, MAX(strength_model) AS mx
                FROM asset_loras WHERE enabled = 1 GROUP BY lora_name
                """
            ).fetchall()
            for r in rows:
                norm = str(r["lora_name"]).replace("\\", "/").lower()
                hist_bounds[norm] = (float(r["mn"]), float(r["mx"]))
        except Exception:
            pass

        range_re = re.compile(
            r"(?:range|weight|strength|recommended|建议|权重|范围)[^0-9\-−]{0,35}([-−]?\d+(?:\.\d+)?)\s*(?:to|~|-|–|—|至|到)\s*([-−]?\d+(?:\.\d+)?)",
            re.IGNORECASE,
        )
        html_re = re.compile(r"<[^>]+>")

        for name in lora_names:
            rel_norm = name.replace("\\", "/")
            detected = None

            # Check sidecar files across all configured LoRA directories
            for loras_dir in lora_dirs:
                fp = loras_dir / rel_norm
                stem = fp.with_suffix("")
                for cand in (
                    Path(str(stem) + ".civitai.info"),
                    Path(str(stem) + ".metadata.json"),
                    Path(str(fp) + ".rgthree-info.json"),
                ):
                    if not cand.exists():
                        continue
                    try:
                        data = json.loads(cand.read_text(encoding="utf-8", errors="ignore"))
                        if not isinstance(data, dict):
                            continue
                        # Explicit rgthree / metadata min/max if present
                        if isinstance(data.get("strengthMin"), (int, float)) and isinstance(data.get("strengthMax"), (int, float)):
                            detected = {"min": float(data["strengthMin"]), "max": float(data["strengthMax"]), "source": "metadata"}
                            break
                        # Parse description / usage_tips HTML
                        texts = [
                            str(data.get("description") or ""),
                            str((data.get("model") or {}).get("description") or ""),
                            str(data.get("usage_tips") or ""),
                        ]
                        plain = html_re.sub(" ", " ".join(texts))
                        matches = range_re.findall(plain)
                        valid_pairs = []
                        for a_s, b_s in matches:
                            a = float(a_s.replace("−", "-"))
                            b = float(b_s.replace("−", "-"))
                            if b > a and -20 <= a <= 20 and -20 <= b <= 20:
                                valid_pairs.append((a, b))
                        if valid_pairs:
                            mn = min(0.0, min(p[0] for p in valid_pairs))
                            mx = max(2.0, max(p[1] for p in valid_pairs))
                            detected = {"min": mn, "max": mx, "source": "civitai_info"}
                            break
                        tags = [str(t).lower() for t in ((data.get("model") or {}).get("tags") or data.get("tags") or [])]
                        if "slider" in tags:
                            detected = {"min": -5.0, "max": 8.0, "source": "civitai_slider_tag"}
                            break
                    except Exception:
                        continue
                if detected:
                    break

            if not detected:
                # Expand from user's historical usage if outside default -2..2
                hb = hist_bounds.get(rel_norm.lower())
                if hb and (hb[0] < -2.0 or hb[1] > 2.0):
                    detected = {
                        "min": float(min(-2.0, int(hb[0]) - 1)),
                        "max": float(max(2.0, int(hb[1]) + 1)),
                        "source": "history",
                    }

            if detected:
                ranges[name] = detected
                ranges[rel_norm] = detected

        return ranges

    async def handle_comfy_loras(self, request: web.Request) -> web.Response:
        # 1. Always fetch live (uncached) LoRA list from ComfyUI /models/loras so newly added LoRAs appear immediately
        items = None
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(
                    f"{COMFY_HTTP_URL}/models/loras",
                    timeout=aiohttp.ClientTimeout(total=4),
                ) as resp:
                    if resp.status == 200:
                        data = await resp.json()
                        if isinstance(data, list):
                            items = [str(x) for x in data]
        except Exception:
            pass

        if items is None:
            # 2. Fallback: scan all configured LoRA dirs (default + extra_model_paths.yaml)
            def _scan_local_loras() -> list:
                seen_lower = set()
                out = []
                for loras_dir in self._get_lora_dirs():
                    for root, _dirs, files in os.walk(loras_dir):
                        for fn in files:
                            if fn.lower().endswith((".safetensors", ".pt", ".ckpt", ".bin")):
                                rel = str((Path(root) / fn).relative_to(loras_dir))
                                key = rel.replace("\\", "/").lower()
                                if key not in seen_lower:
                                    seen_lower.add(key)
                                    out.append(rel)
                out.sort(key=lambda s: s.lower())
                return out

            items = await asyncio.to_thread(_scan_local_loras)

        ranges = await asyncio.to_thread(self._detect_lora_ranges_sync, items)
        return web.json_response({"items": items, "ranges": ranges})

    async def handle_get_settings(self, request: web.Request) -> web.Response:
        wf_dirs = await asyncio.to_thread(self.db.get_setting, "workflow_dirs", DEFAULT_WORKFLOW_DIRS)
        if not isinstance(wf_dirs, list):
            wf_dirs = list(DEFAULT_WORKFLOW_DIRS)
        out_dirs = await asyncio.to_thread(self.db.get_setting, "output_dirs", [str(OUTPUT_DIR)])
        if not isinstance(out_dirs, list) or not out_dirs:
            out_dirs = [str(OUTPUT_DIR)]
        return web.json_response({"workflow_dirs": wf_dirs, "output_dirs": out_dirs})

    async def handle_put_settings(self, request: web.Request) -> web.Response:
        body = await request.json()
        wf_dirs = body.get("workflow_dirs")
        out_dirs = body.get("output_dirs")
        if wf_dirs is not None:
            if not isinstance(wf_dirs, list):
                return web.json_response({"error": "workflow_dirs 必须为路径列表"}, status=400)
            cleaned_wf = [str(d).strip() for d in wf_dirs if str(d).strip()]
            await asyncio.to_thread(self.db.set_setting, "workflow_dirs", cleaned_wf)
        else:
            cleaned_wf = await asyncio.to_thread(self.db.get_setting, "workflow_dirs", DEFAULT_WORKFLOW_DIRS)

        output_changed = False
        if out_dirs is not None:
            if not isinstance(out_dirs, list):
                return web.json_response({"error": "output_dirs 必须为路径列表"}, status=400)
            cleaned_out = [str(d).strip() for d in out_dirs if str(d).strip()]
            if not cleaned_out:
                cleaned_out = [str(OUTPUT_DIR)]
            old_out = await asyncio.to_thread(self.db.get_setting, "output_dirs", [str(OUTPUT_DIR)])
            await asyncio.to_thread(self.db.set_setting, "output_dirs", cleaned_out)
            if cleaned_out != old_out:
                output_changed = True
                await asyncio.to_thread(self.scanner.reload_watchers)
                self.scanner.trigger_scan_background(force_reparse=False)
        else:
            cleaned_out = await asyncio.to_thread(self.db.get_setting, "output_dirs", [str(OUTPUT_DIR)])

        return web.json_response(
            {
                "ok": True,
                "workflow_dirs": cleaned_wf,
                "output_dirs": cleaned_out,
                "output_rescan_triggered": output_changed,
            }
        )

    async def handle_list_workflow_files(self, request: web.Request) -> web.Response:
        force = request.query.get("force") in ("1", "true")
        wf_dirs = await asyncio.to_thread(self.db.get_setting, "workflow_dirs", DEFAULT_WORKFLOW_DIRS)
        if not isinstance(wf_dirs, list):
            wf_dirs = list(DEFAULT_WORKFLOW_DIRS)
        cached = await asyncio.to_thread(self.db.get_workflow_files_cache)
        items, upserts, deleted = await asyncio.to_thread(scan_workflow_dirs, wf_dirs, cached, force)
        if upserts or deleted:
            await asyncio.to_thread(self.db.sync_workflow_files_cache, upserts, deleted)
        return web.json_response(
            {
                "workflow_dirs": wf_dirs,
                "items": items,
                "updated_count": len(upserts),
                "cached_count": len(items) - len(upserts),
            }
        )

    async def handle_load_workflow_file(self, request: web.Request) -> web.Response:
        body = await request.json()
        raw_path = (body.get("path") or "").strip()
        if not raw_path:
            return web.json_response({"error": "缺少工作流文件路径"}, status=400)
        fp = Path(raw_path).resolve()
        # Security guard: ensure file is inside one of the configured workflow_dirs
        wf_dirs = await asyncio.to_thread(self.db.get_setting, "workflow_dirs", DEFAULT_WORKFLOW_DIRS)
        allowed = False
        for d in wf_dirs or []:
            try:
                base = Path(d).resolve()
                if str(fp).lower().startswith(str(base).lower() + os.sep):
                    allowed = True
                    break
            except Exception:
                continue
        if not allowed or not fp.exists() or not fp.is_file():
            return web.json_response({"error": "工作流文件不存在或不在已配置目录中"}, status=404)

        try:
            raw = await asyncio.to_thread(lambda: json.loads(fp.read_text(encoding="utf-8", errors="ignore")))
            ctypes = extract_class_types_from_raw(raw)
            obj_info = await get_comfy_object_info_for_types(ctypes)
            data = await asyncio.to_thread(load_and_convert_workflow_file, fp, obj_info)
            return web.json_response(data)
        except Exception as e:
            return web.json_response({"error": f"解析工作流失败: {e}"}, status=400)

    async def handle_save_workflow_file(self, request: web.Request) -> web.Response:
        body = await request.json()
        raw_path = (body.get("path") or "").strip()
        edited_prompt = body.get("prompt_json")
        if not raw_path or not isinstance(edited_prompt, dict):
            return web.json_response({"error": "缺少路径或工作流参数"}, status=400)
        fp = Path(raw_path).resolve()
        wf_dirs = await asyncio.to_thread(self.db.get_setting, "workflow_dirs", DEFAULT_WORKFLOW_DIRS)
        allowed = False
        for d in wf_dirs or []:
            try:
                base = Path(d).resolve()
                if str(fp).lower().startswith(str(base).lower() + os.sep):
                    allowed = True
                    break
            except Exception:
                continue
        if not allowed or not fp.exists() or not fp.is_file():
            return web.json_response({"error": "工作流文件不存在或不在已配置目录中"}, status=404)

        try:
            raw = await asyncio.to_thread(lambda: json.loads(fp.read_text(encoding="utf-8", errors="ignore")))
            ctypes = extract_class_types_from_raw(raw)
            obj_info = await get_comfy_object_info_for_types(ctypes)
            res = await asyncio.to_thread(save_edits_to_workflow_file, fp, edited_prompt, obj_info)
            return web.json_response(res)
        except Exception as e:
            return web.json_response({"error": f"保存工作流失败: {e}"}, status=400)

    async def _inspect_workflow_prompt_info(self, raw_path: str) -> Dict[str, Any]:
        from .parser import parse_comfy_metadata
        from .prompt_converter import split_divider_prompt

        fp = Path(raw_path).resolve()
        wf_dirs = await asyncio.to_thread(self.db.get_setting, "workflow_dirs", DEFAULT_WORKFLOW_DIRS)
        allowed = False
        for d in wf_dirs or []:
            try:
                base = Path(d).resolve()
                if str(fp).lower().startswith(str(base).lower() + os.sep):
                    allowed = True
                    break
            except Exception:
                continue
        if not allowed or not fp.exists() or not fp.is_file():
            raise FileNotFoundError("工作流文件不存在或不在已配置目录中")

        raw = await asyncio.to_thread(lambda: json.loads(fp.read_text(encoding="utf-8", errors="ignore")))
        ctypes = extract_class_types_from_raw(raw)
        obj_info = await get_comfy_object_info_for_types(ctypes)
        loaded = await asyncio.to_thread(load_and_convert_workflow_file, fp, obj_info)
        prompt_json = loaded.get("prompt_json") or {}
        workflow_json = loaded.get("workflow_json")
        ui_titles = loaded.get("ui_titles") or {}
        parsed = parse_comfy_metadata(prompt_json, workflow_json)
        prompts = parsed.get("prompts") or []

        # Fallback when ComfyUI is offline (widget keys are named widget_0, widget_1, ...)
        if not prompts and isinstance(prompt_json, dict):
            prompt_ct_hints = ("textencode", "prompt", "clip", "string", "text")
            for nid, node in prompt_json.items():
                if not isinstance(node, dict):
                    continue
                ct = str(node.get("class_type") or "")
                ctl = ct.lower()
                if not any(h in ctl for h in prompt_ct_hints) or "clipseg" in ctl or "cliploader" in ctl:
                    continue
                inputs = node.get("inputs") or {}
                title = str(ui_titles.get(str(nid)) or (node.get("_meta") or {}).get("title") or ct)
                tl = title.lower()
                for k, v in inputs.items():
                    if not isinstance(v, str) or len(v.strip()) < 10:
                        continue
                    role = "negative" if any(w in tl for w in ("neg", "负向", "反向")) else "positive"
                    if any(w in tl for w in ("脸", "face", "hand", "手", "衣", "cloth", "精修", "upscale", "detail")):
                        role = "upscale"
                    prompts.append(
                        {
                            "node_id": str(nid),
                            "node_title": title,
                            "class_type": ct,
                            "input_key": k,
                            "role": role,
                            "text": v,
                        }
                    )
            # Sort so main positive prompt (longest or lowest node_id) comes first
            role_order = {"positive": 0, "prompt": 1, "upscale": 2, "system": 3, "negative": 4}
            prompts.sort(key=lambda p: (role_order.get(p["role"], 9), -len(p["text"])))

        # Pick primary prompt node: prefer positive/prompt with ------ divider, else first positive/prompt, else first prompt
        enriched_nodes = []
        for p in prompts:
            txt = str(p.get("text") or "")
            has_div, fixed_pre, edit_suf = split_divider_prompt(txt)
            enriched_nodes.append(
                {
                    "node_id": str(p.get("node_id")),
                    "node_title": str(p.get("node_title") or p.get("class_type") or ""),
                    "class_type": str(p.get("class_type") or ""),
                    "input_key": str(p.get("input_key") or "text"),
                    "role": str(p.get("role") or "prompt"),
                    "text": txt,
                    "has_divider": has_div,
                    "fixed_prefix": fixed_pre,
                    "editable_suffix": edit_suf,
                }
            )

        primary = None
        for n in enriched_nodes:
            if n["role"] in ("positive", "prompt") and n["has_divider"]:
                primary = n
                break
        if primary is None:
            for n in enriched_nodes:
                if n["role"] in ("positive", "prompt"):
                    primary = n
                    break
        if primary is None and enriched_nodes:
            primary = enriched_nodes[0]

        # Infer model_family from parsed base_model or workflow filename
        model_family = parsed.get("model_family")
        if not model_family:
            from .parser import classify_model_family

            model_family = classify_model_family(fp.stem)

        return {
            "workflow_path": str(fp),
            "workflow_name": fp.stem,
            "model_family": model_family or "",
            "prompt_nodes": enriched_nodes,
            "primary_node": primary,
        }

    async def handle_prompt_converter_status(self, request: web.Request) -> web.Response:
        from .prompt_converter import get_converter_status

        return web.json_response(get_converter_status())

    async def handle_prompt_converter_login(self, request: web.Request) -> web.Response:
        from .prompt_converter import open_login_browser_sync

        body = await request.json() if request.can_read_body else {}
        provider = (body.get("provider") or "gemini").strip().lower()
        res = open_login_browser_sync(provider)
        status = 200 if res.get("ok") else 400
        return web.json_response(res, status=status)

    async def handle_prompt_converter_inspect_workflow(self, request: web.Request) -> web.Response:
        body = await request.json()
        raw_path = (body.get("path") or "").strip()
        if not raw_path:
            return web.json_response({"error": "缺少工作流路径"}, status=400)
        try:
            info = await self._inspect_workflow_prompt_info(raw_path)
            return web.json_response(info)
        except Exception as e:
            return web.json_response({"error": str(e)}, status=400)

    async def handle_prompt_converter_convert(self, request: web.Request) -> web.Response:
        from .prompt_converter import build_conversion_instruction, convert_via_web_llm_sync

        body = await request.json()
        source_text = (body.get("source_text") or "").strip()
        provider = (body.get("provider") or "gemini").strip().lower()
        workflow_path = (body.get("workflow_path") or "").strip()
        target_node_id = (body.get("target_node_id") or "").strip()
        target_input_key = (body.get("target_input_key") or "").strip()
        model_family_override = (body.get("model_family") or "").strip()
        lang_pref = (body.get("lang_pref") or "auto").strip().lower()
        show_window = bool(body.get("show_window", False))

        if not source_text:
            return web.json_response({"error": "请输入需要转换的原始提示词或一句话想法"}, status=400)

        has_divider = False
        fixed_prefix = ""
        detected_family = model_family_override
        chosen_node = None

        if workflow_path:
            try:
                info = await self._inspect_workflow_prompt_info(workflow_path)
                if not detected_family:
                    detected_family = info.get("model_family") or ""
                nodes = info.get("prompt_nodes") or []
                if target_node_id:
                    chosen_node = next(
                        (
                            n
                            for n in nodes
                            if n["node_id"] == target_node_id and (not target_input_key or n["input_key"] == target_input_key)
                        ),
                        None,
                    )
                if chosen_node is None:
                    chosen_node = info.get("primary_node")
                if chosen_node:
                    has_divider = bool(chosen_node.get("has_divider"))
                    fixed_prefix = str(chosen_node.get("fixed_prefix") or "")
                    target_node_id = chosen_node["node_id"]
                    target_input_key = chosen_node["input_key"]
            except Exception as e:
                return web.json_response({"error": f"读取工作流失败: {e}"}, status=400)

        instruction = build_conversion_instruction(
            source_text=source_text,
            model_family=detected_family,
            has_divider=has_divider,
            lang_pref=lang_pref,
        )

        try:
            converted_part = await asyncio.to_thread(
                convert_via_web_llm_sync,
                provider,
                instruction,
                show_window,
            )
            if not converted_part:
                return web.json_response({"error": "网页版未返回有效内容，请重试或勾选显示窗口检查"}, status=500)
            if has_divider and fixed_prefix:
                final_prompt = fixed_prefix.rstrip() + "\n\n" + converted_part.strip()
            else:
                final_prompt = converted_part.strip()

            return web.json_response(
                {
                    "ok": True,
                    "provider": provider,
                    "model_family": detected_family,
                    "has_divider": has_divider,
                    "fixed_prefix": fixed_prefix,
                    "converted_part": converted_part.strip(),
                    "final_prompt": final_prompt,
                    "workflow_path": workflow_path,
                    "target_node_id": target_node_id,
                    "target_input_key": target_input_key,
                }
            )
        except Exception as e:
            return web.json_response({"error": str(e)}, status=400)

    async def handle_lora_matrix(self, request: web.Request) -> web.Response:
        data = await asyncio.to_thread(self.db.get_lora_matrix)
        return web.json_response({"items": data})

    async def handle_list_snippets(self, request: web.Request) -> web.Response:
        data = await asyncio.to_thread(self.db.list_snippets)
        return web.json_response({"items": data})

    async def handle_create_snippet(self, request: web.Request) -> web.Response:
        body = await request.json()
        if not (body.get("title") or "").strip() or not (body.get("content") or "").strip():
            return web.json_response({"error": "Title and content required"}, status=400)
        item = await asyncio.to_thread(
            self.db.create_snippet,
            body["title"],
            body.get("category", "通用"),
            body["content"],
            body.get("notes", ""),
        )
        return web.json_response(item)

    async def handle_update_snippet(self, request: web.Request) -> web.Response:
        sid = int(request.match_info["id"])
        body = await request.json()
        item = await asyncio.to_thread(
            self.db.update_snippet,
            sid,
            body.get("title", ""),
            body.get("category", "通用"),
            body.get("content", ""),
            body.get("notes", ""),
        )
        return web.json_response(item or {"error": "Not found"})

    async def handle_delete_snippet(self, request: web.Request) -> web.Response:
        sid = int(request.match_info["id"])
        await asyncio.to_thread(self.db.delete_snippet, sid)
        return web.json_response({"ok": True})

    async def handle_thumb(self, request: web.Request) -> web.StreamResponse:
        name = Path(request.match_info["name"]).name
        p = THUMBS_DIR / name
        if not p.exists():
            raise web.HTTPNotFound()
        resp = web.FileResponse(p)
        resp.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        return resp

    async def handle_thumb_by_id(self, request: web.Request) -> web.StreamResponse:
        asset_id = int(request.match_info["id"])
        row = await asyncio.to_thread(self.db.get_asset_path_row, asset_id)
        if not row:
            raise web.HTTPNotFound()
        fp = self.scanner.resolve_asset_path(row["rel_path"])
        if not fp.exists():
            raise web.HTTPNotFound()
        tname = row.get("thumb_name")
        if not tname or not (THUMBS_DIR / tname).exists():
            async with self.thumb_sem:
                tname = await asyncio.to_thread(
                    ensure_thumbnail, fp, row["rel_path"], row["mtime_ns"], row["file_size"]
                )
            if tname:
                await asyncio.to_thread(self.db.update_thumb, asset_id, tname)
        if tname and (THUMBS_DIR / tname).exists():
            resp = web.FileResponse(THUMBS_DIR / tname)
            resp.headers["Cache-Control"] = "public, max-age=31536000, immutable"
            return resp
        return web.FileResponse(fp)

    async def handle_media(self, request: web.Request) -> web.StreamResponse:
        asset_id = int(request.match_info["id"])
        row = await asyncio.to_thread(self.db.get_asset_path_row, asset_id)
        if not row:
            raise web.HTTPNotFound()
        fp = self.scanner.resolve_asset_path(row["rel_path"])
        if not fp.exists():
            raise web.HTTPNotFound()
        resp = web.FileResponse(fp)
        resp.headers["Cache-Control"] = "public, max-age=86400"
        return resp

    async def handle_reveal_in_explorer(self, request: web.Request) -> web.Response:
        asset_id = int(request.match_info["id"])
        row = await asyncio.to_thread(self.db.get_asset_path_row, asset_id)
        if not row:
            return web.json_response({"error": "Not found"}, status=404)
        fp = self.scanner.resolve_asset_path(row["rel_path"]).resolve()
        if fp.exists():
            import subprocess

            subprocess.Popen(["explorer", "/select,", str(fp)])
        return web.json_response({"ok": True})

    def _resolve_safe_folder(self, folder: str) -> Path:
        folder = (folder or "").replace("\\", "/").strip("/")
        if not folder or ".." in folder.split("/"):
            raise ValueError("非法的目录路径")
        target = self.scanner.resolve_asset_path(folder).resolve()
        roots = [r.resolve() for _p, r in self.scanner.get_output_roots()]
        for root in roots:
            if target == root:
                raise ValueError("不允许操作相册根目录")
            if str(target).lower().startswith(str(root).lower() + os.sep):
                return target
        raise ValueError("不允许操作外部路径")

    async def handle_folder_reveal(self, request: web.Request) -> web.Response:
        body = await request.json()
        folder = (body.get("folder") or "").replace("\\", "/").strip("/")
        fp = OUTPUT_DIR.resolve() if not folder else self._resolve_safe_folder(folder)
        if fp.exists():
            import subprocess

            subprocess.Popen(["explorer", str(fp)])
        return web.json_response({"ok": True})

    async def handle_folder_rename(self, request: web.Request) -> web.Response:
        body = await request.json()
        folder = (body.get("folder") or "").replace("\\", "/").strip("/")
        new_name = (body.get("new_name") or "").strip()
        if not new_name or any(ch in new_name for ch in ("/", "\\", ":", "*", "?", '"', "<", ">", "|")):
            return web.json_response({"error": "文件夹名称包含非法字符"}, status=400)
        try:
            src = self._resolve_safe_folder(folder)
            if not src.exists() or not src.is_dir():
                return web.json_response({"error": "文件夹不存在"}, status=404)
            dst = src.parent / new_name
            if dst.exists():
                return web.json_response({"error": "目标文件夹名称已存在"}, status=400)
            await asyncio.to_thread(src.rename, dst)
            new_rel = str(dst.relative_to(OUTPUT_DIR.resolve())).replace("\\", "/")
            updated = await asyncio.to_thread(self.db.rename_folder_records, folder, new_rel)
            return web.json_response({"ok": True, "new_folder": new_rel, "updated": updated})
        except Exception as e:
            return web.json_response({"error": str(e)}, status=400)

    async def handle_folder_delete(self, request: web.Request) -> web.Response:
        body = await request.json()
        folder = (body.get("folder") or "").replace("\\", "/").strip("/")
        try:
            target = self._resolve_safe_folder(folder)
            if target.exists():
                ok = await asyncio.to_thread(_send_to_recycle_bin, target)
                if not ok:
                    return web.json_response({"error": "移入回收站失败（可能目录正被占用）"}, status=500)
            removed = await asyncio.to_thread(self.db.delete_folder_records, folder)
            return web.json_response({"ok": True, "removed": removed})
        except Exception as e:
            return web.json_response({"error": str(e)}, status=400)

    async def handle_ws(self, request: web.Request) -> web.WebSocketResponse:
        ws = web.WebSocketResponse(heartbeat=25)
        await ws.prepare(request)
        self.ws_clients.add(ws)
        # Send initial state immediately
        await ws.send_str(
            json.dumps(
                {
                    "type": "init",
                    "data": {
                        "comfy_status": self.bridge.state,
                        "scan_status": self.scanner.status,
                        "thumb_status": self.scanner.thumb_status,
                    },
                },
                ensure_ascii=False,
            )
        )
        try:
            async for msg in ws:
                if msg.type == WSMsgType.ERROR:
                    break
        finally:
            self.ws_clients.discard(ws)
        return ws

    async def handle_spa(self, request: web.Request) -> web.StreamResponse:
        rel = request.match_info.get("tail", "")
        if rel:
            cand = (FRONTEND_DIST / rel).resolve()
            if str(cand).startswith(str(FRONTEND_DIST.resolve())) and cand.is_file():
                resp = web.FileResponse(cand)
                if rel.startswith("assets/"):
                    resp.headers["Cache-Control"] = "public, max-age=31536000, immutable"
                return resp
        index_html = FRONTEND_DIST / "index.html"
        if index_html.exists():
            resp = web.FileResponse(index_html)
            resp.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
            return resp
        return web.Response(
            text="ComfyVault backend is running. Frontend dist not built yet.",
            content_type="text/plain",
        )

    def create_app(self) -> web.Application:
        app = web.Application(client_max_size=32 * 1024 * 1024)

        async def on_startup(_app: web.Application) -> None:
            self.loop = asyncio.get_running_loop()
            self.scanner.start_watcher()
            self.bridge.start()
            # Trigger initial incremental scan in background
            self.scanner.trigger_scan_background(force_reparse=False)

        async def on_cleanup(_app: web.Application) -> None:
            await self.bridge.stop()
            self.scanner.stop_watcher()
            for ws in list(self.ws_clients):
                await ws.close()

        app.on_startup.append(on_startup)
        app.on_cleanup.append(on_cleanup)

        app.router.add_get("/api/health", self.handle_health)
        app.router.add_get("/api/facets", self.handle_facets)
        app.router.add_get("/api/assets", self.handle_list_assets)
        app.router.add_get("/api/assets/{id:\\d+}", self.handle_asset_detail)
        app.router.add_patch("/api/assets/{id:\\d+}", self.handle_patch_asset)
        app.router.add_post("/api/assets/batch-trash", self.handle_batch_trash)
        app.router.add_post("/api/assets/purge", self.handle_purge_assets)
        app.router.add_get("/api/assets/{id:\\d+}/raw/{kind:(?:prompt|workflow)}", self.handle_raw_json)
        app.router.add_post("/api/assets/{id:\\d+}/tags", self.handle_attach_tag)
        app.router.add_delete("/api/assets/{id:\\d+}/tags/{tag_id:\\d+}", self.handle_detach_tag)
        app.router.add_post("/api/assets/{id:\\d+}/reroll", self.handle_reroll)
        app.router.add_get("/api/assets/{id:\\d+}/remix-context", self.handle_remix_context)
        app.router.add_post("/api/assets/{id:\\d+}/remix", self.handle_remix)
        app.router.add_post("/api/assets/{id:\\d+}/save-prompt", self.handle_save_asset_prompt)
        app.router.add_post("/api/assets/{id:\\d+}/save-as-workflow", self.handle_save_remix_as_workflow)
        app.router.add_post("/api/assets/{id:\\d+}/reveal", self.handle_reveal_in_explorer)
        app.router.add_put("/api/recipes/{recipe_hash}/note", self.handle_save_recipe_note)
        app.router.add_post("/api/tags", self.handle_create_tag)
        app.router.add_post("/api/scan", self.handle_scan)
        app.router.add_post("/api/comfy/interrupt", self.handle_comfy_interrupt)
        app.router.add_post("/api/comfy/control", self.handle_comfy_control)
        app.router.add_post("/api/comfy/upload-image", self.handle_comfy_upload_image)
        app.router.add_get("/api/comfy/input-image", self.handle_comfy_input_image)
        app.router.add_get("/api/comfy/loras", self.handle_comfy_loras)
        app.router.add_get("/api/settings", self.handle_get_settings)
        app.router.add_put("/api/settings", self.handle_put_settings)
        app.router.add_get("/api/workflows/files", self.handle_list_workflow_files)
        app.router.add_post("/api/workflows/load-file", self.handle_load_workflow_file)
        app.router.add_post("/api/workflows/save-file", self.handle_save_workflow_file)
        app.router.add_get("/api/workflows/templates", self.handle_list_workflow_templates)
        app.router.add_get("/api/workflows/templates/{wf_hash}", self.handle_get_workflow_template)
        app.router.add_put("/api/workflows/templates/{wf_hash}/name", self.handle_rename_workflow_template)
        app.router.add_post("/api/workflows/run", self.handle_run_workflow)
        app.router.add_post("/api/folders/reveal", self.handle_folder_reveal)
        app.router.add_post("/api/folders/rename", self.handle_folder_rename)
        app.router.add_post("/api/folders/delete", self.handle_folder_delete)
        app.router.add_get("/api/loras/matrix", self.handle_lora_matrix)
        app.router.add_get("/api/snippets", self.handle_list_snippets)
        app.router.add_post("/api/snippets", self.handle_create_snippet)
        app.router.add_put("/api/snippets/{id:\\d+}", self.handle_update_snippet)
        app.router.add_delete("/api/snippets/{id:\\d+}", self.handle_delete_snippet)
        app.router.add_get("/api/prompt-converter/status", self.handle_prompt_converter_status)
        app.router.add_post("/api/prompt-converter/login", self.handle_prompt_converter_login)
        app.router.add_post("/api/prompt-converter/inspect-workflow", self.handle_prompt_converter_inspect_workflow)
        app.router.add_post("/api/prompt-converter/convert", self.handle_prompt_converter_convert)
        app.router.add_get("/api/thumbs/{name}", self.handle_thumb)
        app.router.add_get("/api/thumb-by-id/{id:\\d+}", self.handle_thumb_by_id)
        app.router.add_get("/api/media/{id:\\d+}", self.handle_media)
        app.router.add_get("/ws", self.handle_ws)
        app.router.add_get("/", self.handle_spa)
        app.router.add_get("/{tail:.*}", self.handle_spa)
        return app


def run_server() -> None:
    vault = VaultApp()
    app = vault.create_app()
    print(f"[ComfyVault] Starting server at http://{VAULT_HOST}:{VAULT_PORT} (watching {OUTPUT_DIR})")
    web.run_app(app, host=VAULT_HOST, port=VAULT_PORT, print=None)
