import asyncio
import copy
import json
import random
import time
import uuid
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

import aiohttp

from .config import COMFY_HTTP_URL, COMFY_WS_URL, OUTPUT_DIR, detect_comfy_version
from .db import VaultDB
from .scanner import AssetScanner


class ComfyBridge:
    def __init__(
        self,
        db: VaultDB,
        scanner: AssetScanner,
        notify_cb: Optional[Callable[[Dict[str, Any]], None]] = None,
    ):
        self.db = db
        self.scanner = scanner
        self.notify_cb = notify_cb
        self.client_id = f"comfyvault-{uuid.uuid4().hex[:8]}"
        self.local_git_version = detect_comfy_version()

        self.state: Dict[str, Any] = {
            "online": False,
            "comfy_url": COMFY_HTTP_URL,
            "comfy_version": self.local_git_version,
            "queue_remaining": 0,
            "executing_prompt_id": None,
            "executing_node": None,
            "executing_node_title": None,
            "started_at": None,
            "progress_value": 0,
            "progress_max": 0,
        }
        self._start_times: Dict[str, float] = {}
        self._prompt_node_titles: Dict[str, Dict[str, str]] = {}
        self._lineage_map: Dict[str, int] = {}
        self._task: Optional[asyncio.Task] = None
        self._stopped = False

    def _emit(self, event_type: str, payload: Dict[str, Any]) -> None:
        if self.notify_cb:
            try:
                self.notify_cb({"type": event_type, "data": payload})
            except Exception:
                pass

    def start(self) -> None:
        self._stopped = False
        self._task = asyncio.create_task(self._ws_loop())

    async def stop(self) -> None:
        self._stopped = True
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except Exception:
                pass

    async def _refresh_system_stats(self, session: aiohttp.ClientSession) -> None:
        try:
            async with session.get(f"{COMFY_HTTP_URL}/system_stats", timeout=aiohttp.ClientTimeout(total=3)) as resp:
                if resp.status == 200:
                    data = await resp.json()
                    sys_info = data.get("system") or {}
                    ver = sys_info.get("comfyui_version")
                    if ver:
                        if self.local_git_version != "unknown" and self.local_git_version not in ver:
                            self.state["comfy_version"] = f"v{ver} / {self.local_git_version}"
                        else:
                            self.state["comfy_version"] = str(ver)
        except Exception:
            pass

    async def _ws_loop(self) -> None:
        while not self._stopped:
            try:
                async with aiohttp.ClientSession() as session:
                    ws_url = f"{COMFY_WS_URL}?clientId={self.client_id}"
                    async with session.ws_connect(ws_url, heartbeat=20, timeout=5) as ws:
                        self.state["online"] = True
                        await self._refresh_system_stats(session)
                        self._emit("comfy_status", dict(self.state))

                        async for msg in ws:
                            if msg.type == aiohttp.WSMsgType.TEXT:
                                await self._handle_ws_message(session, msg.data)
                            elif msg.type in (aiohttp.WSMsgType.CLOSED, aiohttp.WSMsgType.ERROR):
                                break
            except asyncio.CancelledError:
                break
            except Exception:
                pass

            if self.state["online"]:
                self.state["online"] = False
                self.state["executing_prompt_id"] = None
                self.state["executing_node"] = None
                self.state["progress_value"] = 0
                self.state["progress_max"] = 0
                self._emit("comfy_status", dict(self.state))

            await asyncio.sleep(3.0)

    async def _handle_ws_message(self, session: aiohttp.ClientSession, raw: str) -> None:
        try:
            payload = json.loads(raw)
        except Exception:
            return
        mtype = payload.get("type")
        data = payload.get("data") or {}

        if mtype == "status":
            q = (data.get("status") or {}).get("exec_info", {}).get("queue_remaining", 0)
            self.state["queue_remaining"] = int(q)
            if int(q) == 0 and not self.state["executing_node"]:
                self.state["executing_prompt_id"] = None
                self.state["started_at"] = None
            self._emit("comfy_status", dict(self.state))
        elif mtype == "execution_start":
            pid = data.get("prompt_id")
            if pid:
                now = time.time()
                self._start_times[pid] = now
                self.state["executing_prompt_id"] = pid
                self.state["started_at"] = now
                self.state["executing_node"] = None
                self.state["executing_node_title"] = "准备执行..."
                self.state["progress_value"] = 0
                self.state["progress_max"] = 0
                self._emit("comfy_status", dict(self.state))
        elif mtype == "executing":
            node = data.get("node")
            pid = data.get("prompt_id") or self.state.get("executing_prompt_id")
            self.state["executing_node"] = str(node) if node is not None else None
            if node is None:
                self.state["executing_prompt_id"] = None
                self.state["executing_node_title"] = None
                self.state["started_at"] = None
                self.state["progress_value"] = 0
                self.state["progress_max"] = 0
                if pid:
                    self._prompt_node_titles.pop(pid, None)
                    asyncio.create_task(self._capture_history(pid))
            else:
                if pid and not self.state.get("started_at"):
                    self.state["started_at"] = self._start_times.get(pid, time.time())
                self.state["executing_prompt_id"] = pid
                titles = self._prompt_node_titles.get(pid or "", {})
                self.state["executing_node_title"] = titles.get(str(node)) or f"节点 #{node}"
                self.state["progress_value"] = 0
                self.state["progress_max"] = 0
            self._emit("comfy_status", dict(self.state))
        elif mtype == "progress":
            self.state["progress_value"] = int(data.get("value", 0))
            self.state["progress_max"] = int(data.get("max", 0))
            if data.get("node"):
                nid = str(data["node"])
                self.state["executing_node"] = nid
                pid = data.get("prompt_id") or self.state.get("executing_prompt_id") or ""
                titles = self._prompt_node_titles.get(pid, {})
                if nid in titles:
                    self.state["executing_node_title"] = titles[nid]
            self._emit("comfy_status", dict(self.state))
        elif mtype == "progress_state":
            # ComfyUI newer progress_state payload: {prompt_id, nodes: {nid: {state, value, max}}}
            nodes = data.get("nodes") or {}
            pid = data.get("prompt_id") or self.state.get("executing_prompt_id") or ""
            titles = self._prompt_node_titles.get(pid, {})
            for nid, info in nodes.items():
                if isinstance(info, dict) and info.get("state") == "running":
                    self.state["executing_prompt_id"] = pid or self.state.get("executing_prompt_id")
                    self.state["executing_node"] = str(nid)
                    self.state["executing_node_title"] = titles.get(str(nid)) or f"节点 #{nid}"
                    self.state["progress_value"] = int(info.get("value", 0))
                    self.state["progress_max"] = int(info.get("max", 0))
                    if not self.state.get("started_at"):
                        self.state["started_at"] = time.time()
                    break
            self._emit("comfy_status", dict(self.state))
        elif mtype == "execution_success":
            pid = data.get("prompt_id")
            self.state["executing_prompt_id"] = None
            self.state["executing_node"] = None
            self.state["executing_node_title"] = None
            self.state["started_at"] = None
            self.state["progress_value"] = 0
            self.state["progress_max"] = 0
            self._emit("comfy_status", dict(self.state))
            if pid:
                self._prompt_node_titles.pop(pid, None)
                asyncio.create_task(self._capture_history(pid))
        elif mtype in ("execution_interrupted", "execution_error"):
            self.state["executing_prompt_id"] = None
            self.state["executing_node"] = None
            self.state["executing_node_title"] = None
            self.state["started_at"] = None
            self.state["progress_value"] = 0
            self.state["progress_max"] = 0
            self._emit("comfy_status", dict(self.state))

    async def _capture_history(self, prompt_id: str) -> None:
        # Brief delay to ensure ComfyUI finished flushing files & history
        await asyncio.sleep(0.4)
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(
                    f"{COMFY_HTTP_URL}/history/{prompt_id}", timeout=aiohttp.ClientTimeout(total=8)
                ) as resp:
                    if resp.status != 200:
                        return
                    hist = await resp.json()
        except Exception:
            return

        entry = hist.get(prompt_id)
        if not isinstance(entry, dict):
            return

        prompt_tuple = entry.get("prompt") or []
        prompt_json = prompt_tuple[2] if len(prompt_tuple) >= 3 and isinstance(prompt_tuple[2], dict) else None
        extra_data = prompt_tuple[3] if len(prompt_tuple) >= 4 and isinstance(prompt_tuple[3], dict) else {}
        workflow_json = (extra_data.get("extra_pnginfo") or {}).get("workflow")

        started = self._start_times.pop(prompt_id, None)
        gen_duration = round(time.time() - started, 2) if started else None
        parent_id = self._lineage_map.pop(prompt_id, None)

        outputs = entry.get("outputs") or {}
        indexed_ids = []
        for _nid, node_out in outputs.items():
            if not isinstance(node_out, dict):
                continue
            for key in ("images", "gifs", "videos"):
                for item in node_out.get(key) or []:
                    if not isinstance(item, dict):
                        continue
                    if item.get("type") not in (None, "output"):
                        continue
                    fn = item.get("filename")
                    sub = item.get("subfolder") or ""
                    if not fn:
                        continue
                    fpath = (OUTPUT_DIR / sub / fn) if sub else (OUTPUT_DIR / fn)
                    if fpath.exists():
                        overrides = {
                            "comfy_version": self.state.get("comfy_version") or self.local_git_version,
                            "gen_duration_sec": gen_duration,
                            "parent_id": parent_id,
                            "prompt_json": prompt_json,
                            "workflow_json": workflow_json,
                        }
                        aid = await asyncio.to_thread(self.scanner.index_file, fpath, overrides=overrides)
                        if aid:
                            indexed_ids.append(aid)

        if indexed_ids:
            self._emit("generation_captured", {"prompt_id": prompt_id, "asset_ids": indexed_ids, "parent_id": parent_id})

    async def submit_prompt(
        self,
        prompt_json: Dict[str, Any],
        workflow_json: Optional[Dict[str, Any]] = None,
        parent_id: Optional[int] = None,
    ) -> Dict[str, Any]:
        payload: Dict[str, Any] = {
            "prompt": prompt_json,
            "client_id": self.client_id,
        }
        if workflow_json:
            payload["extra_data"] = {"extra_pnginfo": {"workflow": workflow_json}}

        async with aiohttp.ClientSession() as session:
            async with session.post(
                f"{COMFY_HTTP_URL}/prompt",
                json=payload,
                timeout=aiohttp.ClientTimeout(total=15),
            ) as resp:
                body = await resp.json()
                if resp.status != 200:
                    err_msg = (body.get("error") or {}).get("message") or f"ComfyUI returned HTTP {resp.status}"
                    node_errors = body.get("node_errors") or {}
                    details = []
                    for nid, nerr in node_errors.items():
                        ctype = nerr.get("class_type", "")
                        for e in nerr.get("errors") or []:
                            details.append(f"节点#{nid}({ctype}): {e.get('message', '')} {e.get('details', '')}".strip())
                    if details:
                        err_msg = f"{err_msg} — {'; '.join(details[:3])}"
                    raise RuntimeError(err_msg)
                pid = body.get("prompt_id")
                if pid:
                    # Cache node titles so the live progress bar shows readable node names!
                    titles = {}
                    for nid, node in prompt_json.items():
                        if isinstance(node, dict):
                            t = (node.get("_meta") or {}).get("title") or node.get("class_type")
                            if t:
                                titles[str(nid)] = str(t)
                    self._prompt_node_titles[pid] = titles
                    if parent_id:
                        self._lineage_map[pid] = parent_id
                return body

    async def interrupt_execution(self) -> None:
        async with aiohttp.ClientSession() as session:
            async with session.post(
                f"{COMFY_HTTP_URL}/interrupt",
                timeout=aiohttp.ClientTimeout(total=5),
            ) as resp:
                if resp.status >= 400:
                    raise RuntimeError(f"Interrupt failed (HTTP {resp.status})")

    async def upload_image(self, filename: str, data: bytes, content_type: str = "image/png") -> Dict[str, Any]:
        form = aiohttp.FormData()
        form.add_field("image", data, filename=filename, content_type=content_type)
        form.add_field("overwrite", "true")
        async with aiohttp.ClientSession() as session:
            async with session.post(
                f"{COMFY_HTTP_URL}/upload/image",
                data=form,
                timeout=aiohttp.ClientTimeout(total=20),
            ) as resp:
                body = await resp.json()
                if resp.status != 200:
                    raise RuntimeError(f"Upload failed (HTTP {resp.status})")
                return body

    async def run_custom_prompt(
        self,
        prompt_json: Dict[str, Any],
        workflow_json: Optional[Dict[str, Any]] = None,
        *,
        randomize_seed: bool = True,
        batch_count: int = 1,
    ) -> List[str]:
        """Submit a pre-wired workflow prompt with user-edited node inputs to ComfyUI."""
        batch_count = max(1, min(8, int(batch_count)))
        prompt_ids: List[str] = []
        for idx in range(batch_count):
            run_prompt = copy.deepcopy(prompt_json)
            if randomize_seed or idx > 0:
                seed_val = random.randint(1, 2**31 - 1)
                for node in run_prompt.values():
                    inputs = node.get("inputs") if isinstance(node, dict) else None
                    if isinstance(inputs, dict):
                        for k, v in list(inputs.items()):
                            if k.lower() in ("seed", "noise_seed", "seed_num", "random_seed") and isinstance(v, (int, float)):
                                inputs[k] = seed_val
            res = await self.submit_prompt(run_prompt, workflow_json, parent_id=None)
            if res.get("prompt_id"):
                prompt_ids.append(res["prompt_id"])
        return prompt_ids

    async def reroll_asset(self, asset_id: int, batch_count: int = 1) -> List[str]:
        detail = self.db.get_asset_detail(asset_id)
        raw_prompt, raw_workflow = self.db.get_raw_json(asset_id)
        if not detail or not raw_prompt:
            raise ValueError("该资源缺少完整的 ComfyUI API Prompt 元数据，无法直接再生成")

        batch_count = max(1, min(8, int(batch_count)))
        seed_targets = detail.get("seed_targets") or []
        prompt_ids: List[str] = []

        for _ in range(batch_count):
            patched = copy.deepcopy(raw_prompt)
            new_seed = random.randint(1, 2**31 - 1)
            if seed_targets:
                for st in seed_targets:
                    nid = str(st["node_id"])
                    ikey = st["input_key"]
                    if nid in patched and isinstance(patched[nid].get("inputs"), dict):
                        patched[nid]["inputs"][ikey] = new_seed
            else:
                # Fallback scan for any seed key
                for node in patched.values():
                    inputs = node.get("inputs") if isinstance(node, dict) else None
                    if isinstance(inputs, dict):
                        for k, v in list(inputs.items()):
                            if k.lower() in ("seed", "noise_seed", "seed_num", "random_seed") and isinstance(v, (int, float)):
                                inputs[k] = new_seed
            res = await self.submit_prompt(patched, raw_workflow, parent_id=asset_id)
            if res.get("prompt_id"):
                prompt_ids.append(res["prompt_id"])
        return prompt_ids

    async def remix_asset(
        self,
        asset_id: int,
        *,
        prompt_json_override: Optional[Dict[str, Any]] = None,
        prompt_edits: Optional[List[Dict[str, Any]]] = None,
        lora_edits: Optional[List[Dict[str, Any]]] = None,
        param_edits: Optional[Dict[str, Any]] = None,
        randomize_seed: bool = True,
        batch_count: int = 1,
    ) -> List[str]:
        """Non-destructively patch an asset's prompt JSON and queue new generation(s) in ComfyUI."""
        detail = self.db.get_asset_detail(asset_id)
        raw_prompt, raw_workflow = self.db.get_raw_json(asset_id)
        if not detail or (not raw_prompt and not prompt_json_override):
            raise ValueError("该资源缺少完整的 ComfyUI API Prompt 元数据，无法微调派生")

        base_patched = copy.deepcopy(prompt_json_override or raw_prompt)

        # 1. Apply multi-node prompt edits
        for pe in prompt_edits or []:
            nid = str(pe.get("node_id", ""))
            ikey = pe.get("input_key")
            text = pe.get("text")
            if nid in base_patched and ikey and text is not None:
                inputs = base_patched[nid].get("inputs")
                if isinstance(inputs, dict) and ikey in inputs:
                    inputs[ikey] = str(text)

        # 2. Apply LoRA edits
        for le in lora_edits or []:
            nid = str(le.get("node_id", ""))
            if nid not in base_patched:
                continue
            inputs = base_patched[nid].get("inputs")
            if not isinstance(inputs, dict):
                continue
            mode = le.get("mode", "standard")
            if mode == "rgthree":
                k = le.get("key_name")
                if k and isinstance(inputs.get(k), dict):
                    inputs[k]["on"] = bool(le.get("enabled", True))
                    if "strength_model" in le:
                        inputs[k]["strength"] = float(le["strength_model"])
                    if "strengthTwo" in inputs[k] and "strength_clip" in le:
                        inputs[k]["strengthTwo"] = float(le["strength_clip"])
            else:
                k_sm = le.get("key_strength_model")
                k_sc = le.get("key_strength_clip")
                enabled = bool(le.get("enabled", True))
                sm = float(le.get("strength_model", 1.0)) if enabled else 0.0
                sc = float(le.get("strength_clip", sm)) if enabled else 0.0
                if k_sm and k_sm in inputs:
                    inputs[k_sm] = sm
                if k_sc and k_sc in inputs:
                    inputs[k_sc] = sc

        # 3. Apply sampling param edits
        param_targets = detail.get("param_targets") or {}
        for pname, pval in (param_edits or {}).items():
            if pval is None or pname == "seed":
                continue
            target = param_targets.get(pname)
            if target:
                nid = str(target["node_id"])
                ikey = target["input_key"]
                if nid in base_patched and isinstance(base_patched[nid].get("inputs"), dict):
                    base_patched[nid]["inputs"][ikey] = pval

        batch_count = max(1, min(8, int(batch_count)))
        seed_targets = detail.get("seed_targets") or []
        explicit_seed = (param_edits or {}).get("seed")
        prompt_ids: List[str] = []

        for idx in range(batch_count):
            run_prompt = copy.deepcopy(base_patched)
            if randomize_seed or explicit_seed is None or idx > 0:
                seed_val = random.randint(1, 2**31 - 1)
            else:
                seed_val = int(explicit_seed)

            if seed_targets:
                for st in seed_targets:
                    nid = str(st["node_id"])
                    ikey = st["input_key"]
                    if nid in run_prompt and isinstance(run_prompt[nid].get("inputs"), dict):
                        run_prompt[nid]["inputs"][ikey] = seed_val
            else:
                for node in run_prompt.values():
                    inputs = node.get("inputs") if isinstance(node, dict) else None
                    if isinstance(inputs, dict):
                        for k, v in list(inputs.items()):
                            if k.lower() in ("seed", "noise_seed", "seed_num", "random_seed") and isinstance(v, (int, float)):
                                inputs[k] = seed_val

            res = await self.submit_prompt(run_prompt, raw_workflow, parent_id=asset_id)
            if res.get("prompt_id"):
                prompt_ids.append(res["prompt_id"])

        return prompt_ids
