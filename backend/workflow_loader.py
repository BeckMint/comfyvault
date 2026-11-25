import asyncio
import json
import os
import time
import urllib.parse
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple

import aiohttp

from .config import COMFY_HTTP_URL, COMFY_ROOT

DEFAULT_WORKFLOW_DIRS = [str(COMFY_ROOT / "user" / "default" / "workflows")]

UI_ONLY_TYPES = {
    "Note",
    "MarkdownNote",
    "Reroute",
    "PrimitiveNode",
    "Fast Groups Bypasser (rgthree)",
    "Fast Groups Muter (rgthree)",
    "Label (rgthree)",
    "Bookmark (rgthree)",
}

CONTROL_AFTER_GEN_VALUES = {"fixed", "increment", "decrement", "randomize"}
WIDGET_BASE_TYPES = {"INT", "FLOAT", "STRING", "BOOLEAN", "COMBO", "COMFY_DYNAMICCOMBO_V3"}

_node_info_cache: Dict[str, Any] = {}


async def get_comfy_object_info_for_types(class_types: Set[str]) -> Dict[str, Any]:
    """Fetch & cache ComfyUI /object_info/{class_type} ONLY for the node types used in a workflow (<80ms!)."""
    missing = [ct for ct in class_types if ct and ct not in _node_info_cache]
    if missing:
        async with aiohttp.ClientSession() as session:
            async def _fetch_one(ct: str) -> None:
                try:
                    encoded = urllib.parse.quote(ct, safe="")
                    async with session.get(
                        f"{COMFY_HTTP_URL}/object_info/{encoded}",
                        timeout=aiohttp.ClientTimeout(total=5),
                    ) as resp:
                        if resp.status == 200:
                            data = await resp.json()
                            if isinstance(data, dict) and ct in data:
                                _node_info_cache[ct] = data[ct]
                except Exception:
                    pass

            await asyncio.gather(*(_fetch_one(ct) for ct in missing))
    return {ct: _node_info_cache[ct] for ct in class_types if ct in _node_info_cache}


def extract_class_types_from_raw(raw: Any) -> Set[str]:
    types: Set[str] = set()
    if not isinstance(raw, dict):
        return types
    if isinstance(raw.get("nodes"), list):
        for n in raw["nodes"]:
            if isinstance(n, dict) and n.get("type"):
                types.add(str(n["type"]))
    else:
        src = raw.get("prompt") if isinstance(raw.get("prompt"), dict) else raw
        for v in src.values():
            if isinstance(v, dict) and v.get("class_type"):
                types.add(str(v["class_type"]))
    return types


def scan_workflow_dirs(
    dirs: List[str],
    cached_map: Optional[Dict[str, Dict[str, Any]]] = None,
    force: bool = False,
) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]], List[str]]:
    """Incrementally scan configured directories for ComfyUI workflow .json files.
    Only reads & parses files whose (mtime_ns, file_size) changed since last cached scan!
    Returns: (all_items, upserts, deleted_paths)
    """
    cache = cached_map or {}
    items: List[Dict[str, Any]] = []
    upserts: List[Dict[str, Any]] = []
    seen_paths: Set[str] = set()
    seen_lower: Set[str] = set()

    for raw_dir in dirs:
        d = Path(raw_dir.strip())
        if not d.exists() or not d.is_dir():
            continue
        root_resolved = d.resolve()
        for root, _subdirs, files in os.walk(root_resolved):
            root_p = Path(root)
            for fn in files:
                if not fn.lower().endswith(".json"):
                    continue
                fp = root_p / fn
                resolved_str = str(fp.resolve())
                key_low = resolved_str.lower()
                if key_low in seen_lower:
                    continue
                seen_lower.add(key_low)
                try:
                    st = fp.stat()
                    if st.st_size > 20_000_000 or st.st_size < 20:
                        continue
                    seen_paths.add(resolved_str)

                    # Fast cache hit: unchanged mtime_ns & file_size -> skip disk read & JSON parse!
                    hit = None if force else cache.get(resolved_str)
                    if hit and hit.get("mtime_ns") == st.st_mtime_ns and hit.get("file_size") == st.st_size:
                        items.append(hit)
                        continue

                    rel = str(fp.relative_to(root_resolved)).replace("\\", "/")
                    folder = str(Path(rel).parent).replace("\\", "/")
                    if folder == ".":
                        folder = ""
                    raw = json.loads(fp.read_text(encoding="utf-8", errors="ignore"))
                    if isinstance(raw, dict) and isinstance(raw.get("nodes"), list):
                        fmt = "ui"
                        node_count = len(raw["nodes"])
                    elif isinstance(raw, dict) and any(
                        isinstance(v, dict) and "class_type" in v for v in raw.values()
                    ):
                        fmt = "api"
                        node_count = len(raw)
                    else:
                        continue
                    entry = {
                        "path": resolved_str,
                        "base_dir": str(root_resolved),
                        "rel_path": rel,
                        "folder": folder,
                        "name": fp.stem,
                        "file_size": st.st_size,
                        "mtime": st.st_mtime,
                        "mtime_ns": st.st_mtime_ns,
                        "format": fmt,
                        "node_count": node_count,
                    }
                    items.append(entry)
                    upserts.append(entry)
                except Exception:
                    continue

    deleted_paths = [p for p in cache.keys() if p not in seen_paths]
    items.sort(key=lambda x: x["mtime"], reverse=True)
    return items, upserts, deleted_paths


def _is_widget_spec(spec: Any) -> Tuple[bool, Optional[List[Any]], Dict[str, Any]]:
    if not isinstance(spec, (list, tuple)) or len(spec) == 0:
        return False, None, {}
    t = spec[0]
    opts = spec[1] if len(spec) > 1 and isinstance(spec[1], dict) else {}
    if isinstance(t, list):
        return True, t, opts
    if isinstance(t, str):
        if t in WIDGET_BASE_TYPES:
            choices = None
            raw_opts = opts.get("options")
            if t in ("COMBO", "COMFY_DYNAMICCOMBO_V3") and isinstance(raw_opts, list):
                choices = [
                    o["key"] if isinstance(o, dict) and "key" in o else o
                    for o in raw_opts
                ]
            return True, choices, opts
    return False, None, {}


def _resolve_link(
    link_id: int,
    link_map: Dict[int, Tuple[int, int]],
    node_map: Dict[int, Dict[str, Any]],
    depth: int = 0,
) -> Optional[Tuple[int, int]]:
    if depth > 12 or link_id not in link_map:
        return None
    src_id, src_slot = link_map[link_id]
    src_node = node_map.get(src_id)
    if not src_node:
        return None
    stype = src_node.get("type", "")
    mode = src_node.get("mode", 0)
    if stype == "Reroute" or mode == 4:
        # Trace through first linked input
        for inp in src_node.get("inputs") or []:
            if inp.get("link") is not None:
                return _resolve_link(int(inp["link"]), link_map, node_map, depth + 1)
        return None
    if mode == 2:  # Muted
        return None
    return src_id, src_slot


def load_and_convert_workflow_file(
    file_path: Path, object_info: Dict[str, Any]
) -> Dict[str, Any]:
    """Load a UI or API workflow JSON file and convert to runnable ComfyUI API prompt_json + field_options."""
    raw = json.loads(file_path.read_text(encoding="utf-8", errors="ignore"))
    ui_titles: Dict[str, str] = {}
    field_options: Dict[str, Dict[str, List[Any]]] = {}

    # Case 1: Already API format
    if isinstance(raw, dict) and not isinstance(raw.get("nodes"), list):
        prompt_json = raw.get("prompt") if isinstance(raw.get("prompt"), dict) else raw
        for nid, node in prompt_json.items():
            if not isinstance(node, dict):
                continue
            ctype = node.get("class_type", "")
            meta_t = (node.get("_meta") or {}).get("title")
            if meta_t:
                ui_titles[str(nid)] = str(meta_t)
            info = object_info.get(ctype) or {}
            inp_defs = {**(info.get("input", {}).get("required") or {}), **(info.get("input", {}).get("optional") or {})}
            for k, spec in inp_defs.items():
                is_w, choices, _ = _is_widget_spec(spec)
                if is_w and choices:
                    field_options.setdefault(str(nid), {})[k] = choices
        return {
            "name": file_path.stem,
            "path": str(file_path),
            "format": "api",
            "prompt_json": prompt_json,
            "workflow_json": raw.get("workflow") if isinstance(raw.get("workflow"), dict) else None,
            "ui_titles": ui_titles,
            "field_options": field_options,
        }

    # Case 2: UI format -> Convert to API prompt_json using object_info
    nodes = raw.get("nodes") or []
    links = raw.get("links") or []
    node_map: Dict[int, Dict[str, Any]] = {}
    for n in nodes:
        if isinstance(n, dict) and "id" in n:
            node_map[int(n["id"])] = n

    link_map: Dict[int, Tuple[int, int]] = {}
    for l in links:
        if isinstance(l, list) and len(l) >= 5:
            link_map[int(l[0])] = (int(l[1]), int(l[2]))

    prompt_json: Dict[str, Any] = {}

    for n in nodes:
        if not isinstance(n, dict) or "id" not in n:
            continue
        nid = str(n["id"])
        ctype = str(n.get("type") or "")
        mode = int(n.get("mode") or 0)
        if mode in (2, 4) or ctype in UI_ONLY_TYPES or not ctype:
            continue

        title = n.get("title") or (n.get("properties") or {}).get("Node name for S&R") or ctype
        ui_titles[nid] = str(title)

        inputs_out: Dict[str, Any] = {}
        linked_input_names = set()

        # 1. Resolve all connected links first
        for inp in n.get("inputs") or []:
            if not isinstance(inp, dict):
                continue
            iname = inp.get("name")
            lid = inp.get("link")
            if iname and lid is not None:
                resolved = _resolve_link(int(lid), link_map, node_map)
                if resolved:
                    src_id, src_slot = resolved
                    src_node = node_map.get(src_id)
                    # PrimitiveNode supplies a literal widget value directly
                    if src_node and src_node.get("type") == "PrimitiveNode":
                        wv = src_node.get("widgets_values") or []
                        if wv:
                            inputs_out[iname] = wv[0]
                            linked_input_names.add(iname)
                    else:
                        inputs_out[iname] = [str(src_id), int(src_slot)]
                        linked_input_names.add(iname)

        # 2. Map widgets_values using object_info
        wv = n.get("widgets_values")
        info = object_info.get(ctype) or {}
        req_defs = (info.get("input") or {}).get("required") or {}
        opt_defs = (info.get("input") or {}).get("optional") or {}

        # Special handling: rgthree Power Lora Loader
        if "power lora loader" in ctype.lower() and isinstance(wv, list):
            l_idx = 1
            for entry in wv:
                if isinstance(entry, dict) and "lora" in entry:
                    inputs_out[f"lora_{l_idx}"] = entry
                    l_idx += 1
        elif isinstance(wv, dict):
            for k, v in wv.items():
                if k not in linked_input_names and k != "videopreview":
                    inputs_out[k] = v
        elif isinstance(wv, list):
            # Ordered widget names from required + optional (MUST include linked widgets to keep widgets_values index aligned!)
            widget_specs: List[Tuple[str, Optional[List[Any]], Dict[str, Any]]] = []
            for defs in (req_defs, opt_defs):
                for k, spec in defs.items():
                    is_w, choices, opts = _is_widget_spec(spec)
                    if is_w:
                        if choices:
                            field_options.setdefault(nid, {})[k] = choices
                        widget_specs.append((k, choices, opts))

            if widget_specs:
                wi = 0
                for k, _choices, opts in widget_specs:
                    if wi >= len(wv):
                        # Fill default for required V3 dynamic combo / combo widgets if omitted from widgets_values
                        if k in req_defs and k not in linked_input_names:
                            if "default" in opts:
                                inputs_out[k] = opts["default"]
                            elif _choices:
                                inputs_out[k] = _choices[0]
                        continue
                    val = wv[wi]
                    wi += 1
                    # Only write widget value if this input is NOT driven by a link
                    if k not in linked_input_names:
                        inputs_out[k] = val
                    # ComfyUI injects control_after_generate after seed/noise_seed widgets
                    has_ctrl = opts.get("control_after_generate") is True or k.lower() in (
                        "seed",
                        "noise_seed",
                        "seed_num",
                        "random_seed",
                    )
                    if has_ctrl and wi < len(wv) and isinstance(wv[wi], str) and wv[wi].lower() in CONTROL_AFTER_GEN_VALUES:
                        wi += 1
            else:
                # Fallback if node is unknown to object_info (e.g. ComfyUI offline): preserve positional widgets
                for idx, val in enumerate(wv):
                    if isinstance(val, (str, int, float, bool)):
                        inputs_out[f"widget_{idx}"] = val

        prompt_json[nid] = {
            "class_type": ctype,
            "inputs": inputs_out,
            "_meta": {"title": str(title)},
        }

    return {
        "name": file_path.stem,
        "path": str(file_path),
        "format": "ui",
        "prompt_json": prompt_json,
        "workflow_json": raw,
        "ui_titles": ui_titles,
        "field_options": field_options,
    }


def remap_offline_widget_keys(
    prompt_json: Dict[str, Any],
    object_info: Dict[str, Any],
) -> Dict[str, Any]:
    """If a workflow was opened while ComfyUI was offline (so inputs have positional widget_0, widget_1... keys),
    remap those positional keys to real ComfyUI input names using live object_info right before queueing.
    """
    out: Dict[str, Any] = {}
    for nid, node in prompt_json.items():
        if not isinstance(node, dict) or not isinstance(node.get("inputs"), dict):
            out[nid] = node
            continue
        inps = node["inputs"]
        widget_items = []
        non_widget: Dict[str, Any] = {}
        for k, v in inps.items():
            if k.startswith("widget_") and k[7:].isdigit():
                widget_items.append((int(k[7:]), v))
            else:
                non_widget[k] = v

        if not widget_items:
            out[nid] = node
            continue

        ctype = str(node.get("class_type") or "")
        info = object_info.get(ctype) or {}
        req_defs = (info.get("input") or {}).get("required") or {}
        opt_defs = (info.get("input") or {}).get("optional") or {}

        widget_specs: List[Tuple[str, Optional[List[Any]], Dict[str, Any]]] = []
        for defs in (req_defs, opt_defs):
            for k, spec in defs.items():
                is_w, choices, opts = _is_widget_spec(spec)
                if is_w:
                    widget_specs.append((k, choices, opts))

        if not widget_specs:
            out[nid] = node
            continue

        max_idx = max(idx for idx, _ in widget_items)
        wv: List[Any] = [None] * (max_idx + 1)
        for idx, val in widget_items:
            wv[idx] = val

        linked_names = {k for k, v in non_widget.items() if isinstance(v, list)}
        remapped = dict(non_widget)
        wi = 0
        for k, _choices, opts in widget_specs:
            if wi >= len(wv):
                break
            val = wv[wi]
            wi += 1
            if k not in linked_names and val is not None:
                remapped[k] = val
            has_ctrl = opts.get("control_after_generate") is True or k.lower() in (
                "seed",
                "noise_seed",
                "seed_num",
                "random_seed",
            )
            if has_ctrl and wi < len(wv) and isinstance(wv[wi], str) and wv[wi].lower() in CONTROL_AFTER_GEN_VALUES:
                wi += 1

        out[nid] = {**node, "inputs": remapped}
    return out


def save_edits_to_workflow_file(
    file_path: Path,
    edited_prompt_json: Dict[str, Any],
    object_info: Dict[str, Any],
) -> Dict[str, Any]:
    """Surgically write edited node inputs back into a UI or API workflow JSON file on disk."""
    raw = json.loads(file_path.read_text(encoding="utf-8", errors="ignore"))
    updated_nodes = 0

    if isinstance(raw, dict) and not isinstance(raw.get("nodes"), list):
        # API format file
        target = raw["prompt"] if isinstance(raw.get("prompt"), dict) else raw
        for nid, enode in edited_prompt_json.items():
            if nid in target and isinstance(target[nid], dict) and isinstance(enode, dict):
                e_inputs = enode.get("inputs") or {}
                t_inputs = target[nid].setdefault("inputs", {})
                for k, v in e_inputs.items():
                    if not isinstance(v, list):
                        t_inputs[k] = v
                updated_nodes += 1
    elif isinstance(raw, dict) and isinstance(raw.get("nodes"), list):
        # UI format file: patch widgets_values in-place while preserving all links/positions/groups
        for n in raw["nodes"]:
            if not isinstance(n, dict) or "id" not in n:
                continue
            nid = str(n["id"])
            enode = edited_prompt_json.get(nid)
            if not isinstance(enode, dict):
                continue
            e_inputs = enode.get("inputs") or {}
            ctype = str(n.get("type") or "")
            wv = n.get("widgets_values")

            linked_input_names = {
                inp.get("name")
                for inp in (n.get("inputs") or [])
                if isinstance(inp, dict) and inp.get("name") and inp.get("link") is not None
            }

            if "power lora loader" in ctype.lower() and isinstance(wv, list):
                # Rebuild rgthree Power Lora Loader widgets_values preserving header & trailing entries
                prefix = []
                suffix = []
                seen_lora = False
                for entry in wv:
                    if isinstance(entry, dict) and "lora" in entry:
                        seen_lora = True
                    elif not seen_lora:
                        prefix.append(entry)
                    else:
                        suffix.append(entry)
                if not prefix:
                    prefix = [{}, {"type": "PowerLoraLoaderHeaderWidget"}]
                if not suffix:
                    suffix = ["", ""]

                lora_items = sorted(
                    [
                        (int(k.split("_", 1)[1]), v)
                        for k, v in e_inputs.items()
                        if k.startswith("lora_") and k.split("_", 1)[1].isdigit() and isinstance(v, dict) and "lora" in v
                    ],
                    key=lambda x: x[0],
                )
                n["widgets_values"] = prefix + [v for _, v in lora_items] + suffix
                updated_nodes += 1
            elif isinstance(wv, dict):
                changed = False
                for k in list(wv.keys()):
                    if k not in linked_input_names and k in e_inputs and not isinstance(e_inputs[k], list):
                        wv[k] = e_inputs[k]
                        changed = True
                if changed:
                    updated_nodes += 1
            elif isinstance(wv, list):
                info = object_info.get(ctype) or {}
                req_defs = (info.get("input") or {}).get("required") or {}
                opt_defs = (info.get("input") or {}).get("optional") or {}
                widget_specs: List[Tuple[str, Dict[str, Any]]] = []
                for defs in (req_defs, opt_defs):
                    for k, spec in defs.items():
                        is_w, _choices, opts = _is_widget_spec(spec)
                        if is_w:
                            widget_specs.append((k, opts))

                if widget_specs:
                    wi = 0
                    changed = False
                    for k, opts in widget_specs:
                        if wi >= len(wv):
                            break
                        if k not in linked_input_names and k in e_inputs and not isinstance(e_inputs[k], list):
                            wv[wi] = e_inputs[k]
                            changed = True
                        wi += 1
                        has_ctrl = opts.get("control_after_generate") is True or k.lower() in (
                            "seed",
                            "noise_seed",
                            "seed_num",
                            "random_seed",
                        )
                        if has_ctrl and wi < len(wv) and isinstance(wv[wi], str) and wv[wi].lower() in CONTROL_AFTER_GEN_VALUES:
                            wi += 1
                    if changed:
                        updated_nodes += 1
                else:
                    changed = False
                    for idx in range(len(wv)):
                        ek = f"widget_{idx}"
                        if ek in e_inputs and not isinstance(e_inputs[ek], list):
                            wv[idx] = e_inputs[ek]
                            changed = True
                    if changed:
                        updated_nodes += 1

    # Atomic save to disk
    tmp_path = file_path.with_suffix(file_path.suffix + ".tmp")
    tmp_path.write_text(json.dumps(raw, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp_path.replace(file_path)
    st = file_path.stat()
    return {
        "ok": True,
        "updated_nodes": updated_nodes,
        "mtime": st.st_mtime,
        "mtime_ns": st.st_mtime_ns,
        "file_size": st.st_size,
    }
