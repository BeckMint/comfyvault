import asyncio
import copy
import ctypes
import json
import os
import random
import time
import uuid
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

import aiohttp

from .config import COMFY_HTTP_URL, COMFY_WS_URL, OUTPUT_DIR, detect_comfy_version
from .db import VaultDB
from .scanner import AssetScanner


class _MEMORYSTATUSEX(ctypes.Structure):
    _fields_ = [
        ("dwLength", ctypes.c_ulong),
        ("dwMemoryLoad", ctypes.c_ulong),
        ("ullTotalPhys", ctypes.c_ulonglong),
        ("ullAvailPhys", ctypes.c_ulonglong),
        ("ullTotalPageFile", ctypes.c_ulonglong),
        ("ullAvailPageFile", ctypes.c_ulonglong),
        ("ullTotalVirtual", ctypes.c_ulonglong),
        ("ullAvailVirtual", ctypes.c_ulonglong),
        ("ullAvailExtendedVirtual", ctypes.c_ulonglong),
    ]


def _read_system_memory() -> Dict[str, Any]:
    if os.name == "nt":
        try:
            st = _MEMORYSTATUSEX()
            st.dwLength = ctypes.sizeof(_MEMORYSTATUSEX)
            if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(st)):
                gb = 1073741824.0
                total_phys = st.ullTotalPhys / gb
                avail_phys = st.ullAvailPhys / gb
                used_phys = max(0.0, total_phys - avail_phys)
                total_pf = st.ullTotalPageFile / gb
                avail_pf = st.ullAvailPageFile / gb
                used_pf = max(0.0, total_pf - avail_pf)
                commit_pct = int(round((used_pf / total_pf) * 100)) if total_pf > 0 else 0
                return {
                    "ram_total_gb": round(total_phys, 1),
                    "ram_used_gb": round(used_phys, 1),
                    "ram_free_gb": round(avail_phys, 1),
                    "ram_pct": int(st.dwMemoryLoad),
                    "commit_total_gb": round(total_pf, 1),
                    "commit_used_gb": round(used_pf, 1),
                    "commit_pct": commit_pct,
                }
        except Exception:
            pass
    return {}


def _fmt_duration_zh(sec: float) -> str:
    s = max(0, int(round(sec)))
    if s >= 60:
        m, r = divmod(s, 60)
        return f"{m} 分 {r} 秒" if r else f"{m} 分钟"
    return f"{s} 秒"


def _fmt_duration_en(sec: float) -> str:
    s = max(0, int(round(sec)))
    if s >= 60:
        m, r = divmod(s, 60)
        return f"{m}m {r}s" if r else f"{m}m"
    return f"{s}s"


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
            "resources": None,
            "alert": None,
        }
        self._start_times: Dict[str, float] = {}
        self._prompt_node_titles: Dict[str, Dict[str, str]] = {}
        self._lineage_map: Dict[str, int] = {}
        self._ref_image_map: Dict[str, str] = {}
        self._node_started_at: Optional[float] = None
        self._last_step_at: Optional[float] = None
        self._last_step_value: int = 0
        self._last_step_duration: float = 0.0
        self._task: Optional[asyncio.Task] = None
        self._monitor_task: Optional[asyncio.Task] = None
        self._stopped = False
        self.scanner.set_comfy_executing_check(
            lambda: bool(
                self.state.get("online")
                and (
                    self.state.get("executing_prompt_id")
                    or self.state.get("executing_node")
                    or (self.state.get("queue_remaining") or 0) > 0
                )
            )
        )

    def _emit(self, event_type: str, payload: Dict[str, Any]) -> None:
        if self.notify_cb:
            try:
                self.notify_cb({"type": event_type, "data": payload})
            except Exception:
                pass

    def start(self) -> None:
        self._stopped = False
        self._task = asyncio.create_task(self._ws_loop())
        self._monitor_task = asyncio.create_task(self._monitor_loop())

    async def stop(self) -> None:
        self._stopped = True
        for t in (self._task, self._monitor_task):
            if t:
                t.cancel()
                try:
                    await t
                except Exception:
                    pass

    def _reset_exec_trackers(self) -> None:
        self._node_started_at = None
        self._last_step_at = None
        self._last_step_value = 0
        self._last_step_duration = 0.0
        self.state["alert"] = None

    def _evaluate_alert(self, res: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        is_executing = bool(self.state.get("online") and (self.state.get("executing_prompt_id") or self.state.get("executing_node")))
        if not is_executing:
            return None

        now = time.time()
        ram_pct = int(res.get("ram_pct") or 0)
        ram_used = float(res.get("ram_used_gb") or 0)
        ram_total = float(res.get("ram_total_gb") or 0)
        ram_free = float(res.get("ram_free_gb") or 99)
        commit_pct = int(res.get("commit_pct") or 0)
        commit_used = float(res.get("commit_used_gb") or 0)
        commit_total = float(res.get("commit_total_gb") or 0)
        vram_pct = int(res.get("vram_pct") or 0)
        vram_used = float(res.get("vram_used_gb") or 0)
        vram_total = float(res.get("vram_total_gb") or 0)

        pmax = int(self.state.get("progress_max") or 0)
        node_title = str(self.state.get("executing_node_title") or self.state.get("executing_node") or "当前节点")
        step_elapsed = (now - self._last_step_at) if self._last_step_at else ((now - self._node_started_at) if self._node_started_at else 0.0)
        node_elapsed = (now - self._node_started_at) if self._node_started_at else 0.0
        worst_step = max(step_elapsed, self._last_step_duration)

        # --- DANGER LEVEL ---
        if ram_pct >= 92 or (ram_total > 0 and ram_free <= 1.8):
            return {
                "level": "danger",
                "code": "ram_critical",
                "title_zh": "内存严重告急",
                "title_en": "Critical RAM Pressure",
                "message_zh": f"系统内存占用已达 {ram_pct}%（{ram_used}/{ram_total} GB，仅剩 {ram_free} GB），正在重度磁盘换页，继续运行可能导致卡死或推理极慢。",
                "message_en": f"System RAM at {ram_pct}% ({ram_used}/{ram_total} GB, {ram_free} GB free). Heavy paging may stall or freeze the system.",
            }
        if vram_pct >= 96 and ram_pct >= 85:
            return {
                "level": "danger",
                "code": "vram_ram_critical",
                "title_zh": "显存与内存双重满载",
                "title_en": "VRAM + RAM Saturated",
                "message_zh": f"显存 {vram_pct}%（{vram_used}/{vram_total} GB）且内存 {ram_pct}%（{ram_used}/{ram_total} GB），正在高频 Offload 换页，极易 OOM 或拖慢至小时级。",
                "message_en": f"VRAM {vram_pct}% ({vram_used}/{vram_total} GB) & RAM {ram_pct}% ({ram_used}/{ram_total} GB). Heavy offload may cause OOM or extreme slowdown.",
            }
        if commit_pct >= 92 and commit_total > 0:
            return {
                "level": "danger",
                "code": "commit_critical",
                "title_zh": "虚拟内存提交告急",
                "title_en": "Virtual Memory Critical",
                "message_zh": f"系统提交内存已达 {commit_pct}%（{commit_used}/{commit_total} GB），继续执行可能触发内存溢出崩溃。",
                "message_en": f"System commit charge at {commit_pct}% ({commit_used}/{commit_total} GB). Risk of out-of-memory crash.",
            }
        if pmax > 0 and worst_step >= 180:
            return {
                "level": "danger",
                "code": "step_stall",
                "title_zh": "采样单步异常缓慢",
                "title_en": "Sampling Step Stalled",
                "message_zh": f"当前采样单步耗时已达 {_fmt_duration_zh(worst_step)}（显存 {vram_pct}% / 内存 {ram_pct}%），疑似触发高频显存-内存换页或参数过重。",
                "message_en": f"Current sampling step has taken {_fmt_duration_en(worst_step)} (VRAM {vram_pct}% / RAM {ram_pct}%). Possible heavy offload or stall.",
            }
        if pmax == 0 and node_elapsed >= 300 and (ram_pct >= 85 or vram_pct >= 94):
            return {
                "level": "danger",
                "code": "node_stall",
                "title_zh": "节点长时间无响应",
                "title_en": "Node Unresponsive",
                "message_zh": f"节点「{node_title}」已持续 {_fmt_duration_zh(node_elapsed)} 无进度且资源吃紧（显存 {vram_pct}% / 内存 {ram_pct}%），建议终止检查。",
                "message_en": f"Node '{node_title}' has run for {_fmt_duration_en(node_elapsed)} with high resource pressure (VRAM {vram_pct}% / RAM {ram_pct}%).",
            }

        # --- WARN LEVEL ---
        if ram_pct >= 85:
            return {
                "level": "warn",
                "code": "ram_high",
                "title_zh": "内存占用偏高",
                "title_en": "High RAM Usage",
                "message_zh": f"系统内存已占用 {ram_pct}%（{ram_used}/{ram_total} GB，剩余 {ram_free} GB），接近上限，请注意观察是否继续上涨。",
                "message_en": f"System RAM at {ram_pct}% ({ram_used}/{ram_total} GB, {ram_free} GB free). Monitor closely.",
            }
        if vram_pct >= 94 and vram_total > 0:
            return {
                "level": "warn",
                "code": "vram_high",
                "title_zh": "显存接近上限",
                "title_en": "VRAM Near Limit",
                "message_zh": f"显存占用 {vram_pct}%（{vram_used}/{vram_total} GB），可能触发频繁 Offload 导致生成明显变慢。",
                "message_en": f"VRAM at {vram_pct}% ({vram_used}/{vram_total} GB). Frequent offloading may slow generation.",
            }
        if pmax > 0 and worst_step >= 90:
            return {
                "level": "warn",
                "code": "step_slow",
                "title_zh": "单步耗时偏长",
                "title_en": "Slow Sampling Step",
                "message_zh": f"当前采样单步已耗时 {_fmt_duration_zh(worst_step)}（显存 {vram_pct}% / 内存 {ram_pct}%），如非预期大模型可考虑终止任务。",
                "message_en": f"Sampling step has taken {_fmt_duration_en(worst_step)} (VRAM {vram_pct}% / RAM {ram_pct}%).",
            }
        return None

    async def _monitor_loop(self) -> None:
        while not self._stopped:
            is_busy = bool(
                self.state.get("online")
                and (
                    self.state.get("executing_prompt_id")
                    or self.state.get("executing_node")
                    or (self.state.get("queue_remaining") or 0) > 0
                )
            )
            interval = 2.5 if is_busy else 8.0
            try:
                if self.state.get("online"):
                    mem = _read_system_memory()
                    vram_info: Dict[str, Any] = {}
                    try:
                        async with aiohttp.ClientSession() as session:
                            async with session.get(
                                f"{COMFY_HTTP_URL}/system_stats", timeout=aiohttp.ClientTimeout(total=2.5)
                            ) as resp:
                                if resp.status == 200:
                                    data = await resp.json()
                                    devs = data.get("devices") or []
                                    if devs and isinstance(devs[0], dict):
                                        d0 = devs[0]
                                        vt = float(d0.get("vram_total") or 0)
                                        vf = float(d0.get("vram_free") or 0)
                                        if vt > 0:
                                            vu = max(0.0, vt - vf)
                                            gb = 1073741824.0
                                            vram_info = {
                                                "vram_total_gb": round(vt / gb, 1),
                                                "vram_used_gb": round(vu / gb, 1),
                                                "vram_pct": int(round((vu / vt) * 100)),
                                            }
                    except Exception:
                        pass

                    now = time.time()
                    step_sec = 0
                    if is_busy:
                        base_t = self._last_step_at or self._node_started_at
                        if base_t:
                            step_sec = max(0, int(round(now - base_t)))

                    res = {**mem, **vram_info, "step_sec": step_sec}
                    if res:
                        self.state["resources"] = res
                    new_alert = self._evaluate_alert(res)
                    prev_alert = self.state.get("alert")
                    self.state["alert"] = new_alert
                    if is_busy or new_alert != prev_alert:
                        self._emit("comfy_status", dict(self.state))
            except asyncio.CancelledError:
                break
            except Exception:
                pass
            await asyncio.sleep(interval)

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
                self._reset_exec_trackers()
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
                self._reset_exec_trackers()
                self._node_started_at = now
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
                self._reset_exec_trackers()
                if pid:
                    self._prompt_node_titles.pop(pid, None)
                    asyncio.create_task(self._capture_history(pid))
            else:
                now = time.time()
                self._node_started_at = now
                self._last_step_at = None
                self._last_step_value = 0
                self._last_step_duration = 0.0
                if pid and not self.state.get("started_at"):
                    self.state["started_at"] = self._start_times.get(pid, now)
                self.state["executing_prompt_id"] = pid
                titles = self._prompt_node_titles.get(pid or "", {})
                self.state["executing_node_title"] = titles.get(str(node)) or f"节点 #{node}"
                self.state["progress_value"] = 0
                self.state["progress_max"] = 0
            self._emit("comfy_status", dict(self.state))
        elif mtype == "progress":
            now = time.time()
            val = int(data.get("value", 0))
            if val != self._last_step_value:
                if self._last_step_at is not None and val > self._last_step_value:
                    self._last_step_duration = max(0.0, now - self._last_step_at)
                self._last_step_at = now
                self._last_step_value = val
            self.state["progress_value"] = val
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
            now = time.time()
            for nid, info in nodes.items():
                if isinstance(info, dict) and info.get("state") == "running":
                    val = int(info.get("value", 0))
                    if str(nid) != self.state.get("executing_node"):
                        self._node_started_at = now
                        self._last_step_at = now if val > 0 else None
                        self._last_step_value = val
                        self._last_step_duration = 0.0
                    elif val != self._last_step_value:
                        if self._last_step_at is not None and val > self._last_step_value:
                            self._last_step_duration = max(0.0, now - self._last_step_at)
                        self._last_step_at = now
                        self._last_step_value = val
                    self.state["executing_prompt_id"] = pid or self.state.get("executing_prompt_id")
                    self.state["executing_node"] = str(nid)
                    self.state["executing_node_title"] = titles.get(str(nid)) or f"节点 #{nid}"
                    self.state["progress_value"] = val
                    self.state["progress_max"] = int(info.get("max", 0))
                    if not self.state.get("started_at"):
                        self.state["started_at"] = now
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
            self._reset_exec_trackers()
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
            self._reset_exec_trackers()
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
        ref_image = self._ref_image_map.pop(prompt_id, None)

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
                            "reference_image": ref_image,
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
        reference_image: Optional[str] = None,
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
                    if reference_image:
                        self._ref_image_map[pid] = reference_image
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
        reference_image: Optional[str] = None,
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
            res = await self.submit_prompt(run_prompt, workflow_json, parent_id=None, reference_image=reference_image)
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
            res = await self.submit_prompt(
                patched, raw_workflow, parent_id=asset_id, reference_image=detail.get("reference_image")
            )
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

            res = await self.submit_prompt(
                run_prompt, raw_workflow, parent_id=asset_id, reference_image=detail.get("reference_image")
            )
            if res.get("prompt_id"):
                prompt_ids.append(res["prompt_id"])

        return prompt_ids
