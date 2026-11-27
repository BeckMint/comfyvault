import hashlib
import json
import os
import re
import subprocess
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from PIL import Image

from .config import IMAGE_EXTS, VIDEO_EXTS

VOLATILE_KEYS = {
    "seed",
    "noise_seed",
    "seed_num",
    "random_seed",
    "filename_prefix",
    "file_name",
    "output_path",
    "save_prefix",
    "control_after_generate",
    "timestamp",
    "batch_index",
}

TEXT_INPUT_KEYS = {
    "text",
    "prompt",
    "positive",
    "negative",
    "positive_prompt",
    "negative_prompt",
    "text_g",
    "text_l",
    "clip_l",
    "t5xxl",
    "system_prompt",
    "user_prompt",
    "caption",
    "string",
    "text_positive",
    "text_negative",
}

FILE_EXT_RE = re.compile(
    r"\.(safetensors|ckpt|pt|pth|bin|gguf|onnx|png|jpg|jpeg|webp|mp4|webm|mov|json|yaml|txt|lora)$",
    re.IGNORECASE,
)


def _safe_json_loads(raw: Any) -> Optional[Any]:
    if raw is None:
        return None
    if isinstance(raw, (dict, list)):
        return raw
    if not isinstance(raw, str):
        return None
    s = raw.strip()
    if not s or (s[0] not in "{["):
        return None
    try:
        return json.loads(s)
    except Exception:
        # Handle NaN/Infinity sometimes emitted by ComfyUI
        try:
            fixed = re.sub(r"\bNaN\b", "null", s)
            fixed = re.sub(r"\bInfinity\b", "null", fixed)
            return json.loads(fixed)
        except Exception:
            return None


def extract_media_info_and_metadata(file_path: Path) -> Dict[str, Any]:
    """Extract dimensions, duration/fps (for video), and ComfyUI prompt/workflow JSON."""
    ext = file_path.suffix.lower()
    result: Dict[str, Any] = {
        "media_type": "video" if ext in VIDEO_EXTS else "image",
        "width": 0,
        "height": 0,
        "duration": None,
        "fps": None,
        "prompt_json": None,
        "workflow_json": None,
        "raw_parameters": None,
    }

    if ext in IMAGE_EXTS:
        try:
            with Image.open(file_path) as img:
                result["width"], result["height"] = img.size
                info = img.info or {}
                if "prompt" in info:
                    result["prompt_json"] = _safe_json_loads(info.get("prompt"))
                if "workflow" in info:
                    result["workflow_json"] = _safe_json_loads(info.get("workflow"))
                if "parameters" in info and not result["prompt_json"]:
                    result["raw_parameters"] = str(info.get("parameters"))

                # WebP / JPEG EXIF fallback (skip PNG to avoid scanning full IDAT chunks)
                if ext != ".png" and not result["prompt_json"] and not result["workflow_json"]:
                    try:
                        exif = img.getexif()
                        if exif:
                            for tag_id, val in exif.items():
                                if isinstance(val, bytes):
                                    try:
                                        val = val.decode("utf-8", errors="ignore")
                                    except Exception:
                                        continue
                                if isinstance(val, str):
                                    if val.startswith("Prompt:"):
                                        result["prompt_json"] = _safe_json_loads(val[7:])
                                    elif val.startswith("Workflow:"):
                                        result["workflow_json"] = _safe_json_loads(val[9:])
                                    elif '"class_type"' in val and not result["prompt_json"]:
                                        result["prompt_json"] = _safe_json_loads(val)
                                    elif '"nodes"' in val and not result["workflow_json"]:
                                        result["workflow_json"] = _safe_json_loads(val)
                    except Exception:
                        pass
        except Exception:
            pass
    elif ext in VIDEO_EXTS:
        _extract_video_pyav(file_path, result)
        if result["width"] == 0 or (not result["prompt_json"] and not result["workflow_json"]):
            _extract_video_ffprobe(file_path, result)

    # Optional sidecar .json fallback
    if not result["prompt_json"]:
        sidecar = file_path.with_suffix(".json")
        if sidecar.exists() and sidecar.stat().st_size < 10_000_000:
            try:
                data = _safe_json_loads(sidecar.read_text(encoding="utf-8", errors="ignore"))
                if isinstance(data, dict):
                    if "prompt" in data and isinstance(data["prompt"], dict):
                        result["prompt_json"] = data["prompt"]
                        if "workflow" in data:
                            result["workflow_json"] = data["workflow"]
                    elif any(isinstance(v, dict) and "class_type" in v for v in data.values()):
                        result["prompt_json"] = data
            except Exception:
                pass

    return result


def _parse_video_tags(tags: Dict[str, Any], result: Dict[str, Any]) -> None:
    for k, v in (tags or {}).items():
        if not isinstance(v, str) or not v.strip():
            continue
        kl = str(k).strip().lower()
        parsed = _safe_json_loads(v)
        if not isinstance(parsed, dict):
            continue
        if kl == "prompt" and not result["prompt_json"]:
            result["prompt_json"] = parsed
            continue
        if kl == "workflow" and not result["workflow_json"]:
            result["workflow_json"] = parsed
            continue
        if "prompt" in parsed and not result["prompt_json"]:
            p = _safe_json_loads(parsed["prompt"]) if isinstance(parsed["prompt"], str) else parsed["prompt"]
            if isinstance(p, dict):
                result["prompt_json"] = p
        if "workflow" in parsed and not result["workflow_json"]:
            w = _safe_json_loads(parsed["workflow"]) if isinstance(parsed["workflow"], str) else parsed["workflow"]
            if isinstance(w, dict):
                result["workflow_json"] = w
        if not result["prompt_json"] and any(
            isinstance(nv, dict) and "class_type" in nv for nv in parsed.values()
        ):
            result["prompt_json"] = parsed
        elif not result["workflow_json"] and "nodes" in parsed:
            result["workflow_json"] = parsed


def _extract_video_pyav(file_path: Path, result: Dict[str, Any]) -> None:
    try:
        import av  # type: ignore

        with av.open(str(file_path)) as container:
            vstreams = [s for s in container.streams if s.type == "video"]
            if vstreams:
                st = vstreams[0]
                if st.width and st.height:
                    result["width"] = int(st.width)
                    result["height"] = int(st.height)
                rate = st.average_rate or st.guessed_rate
                if rate:
                    try:
                        fps = float(rate)
                        if fps > 0:
                            result["fps"] = round(fps, 2)
                    except Exception:
                        pass
            if container.duration:
                try:
                    result["duration"] = round(float(container.duration) / 1_000_000.0, 2)
                except Exception:
                    pass
            _parse_video_tags(dict(container.metadata or {}), result)
    except Exception:
        pass


def _extract_video_ffprobe(file_path: Path, result: Dict[str, Any]) -> None:
    try:
        proc = subprocess.run(
            [
                "ffprobe",
                "-v",
                "quiet",
                "-print_format",
                "json",
                "-show_format",
                "-show_streams",
                str(file_path),
            ],
            capture_output=True,
            text=True,
            stdin=subprocess.DEVNULL,
            timeout=5,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        if proc.returncode != 0 or not proc.stdout:
            return
        data = json.loads(proc.stdout)
        for st in data.get("streams", []):
            if st.get("codec_type") == "video":
                result["width"] = int(st.get("width") or 0)
                result["height"] = int(st.get("height") or 0)
                rfr = st.get("avg_frame_rate") or st.get("r_frame_rate")
                if rfr and "/" in str(rfr):
                    num, den = str(rfr).split("/", 1)
                    try:
                        if float(den) > 0:
                            result["fps"] = round(float(num) / float(den), 2)
                    except Exception:
                        pass
                if st.get("duration"):
                    try:
                        result["duration"] = round(float(st["duration"]), 2)
                    except Exception:
                        pass
                break

        fmt = data.get("format", {})
        if result["duration"] is None and fmt.get("duration"):
            try:
                result["duration"] = round(float(fmt["duration"]), 2)
            except Exception:
                pass

        tags = fmt.get("tags") or {}
        _parse_video_tags(tags, result)
    except Exception:
        pass


def _build_ui_title_map(workflow_json: Optional[Dict[str, Any]]) -> Dict[str, str]:
    titles: Dict[str, str] = {}
    if not isinstance(workflow_json, dict):
        return titles
    for node in workflow_json.get("nodes", []) or []:
        if isinstance(node, dict) and "id" in node:
            title = node.get("title") or node.get("properties", {}).get("Node name for S&R")
            if title:
                titles[str(node["id"])] = str(title)
    # Also scan subgraphs if present
    defs = workflow_json.get("definitions") or {}
    for sg in defs.get("subgraphs", []) or []:
        if isinstance(sg, dict):
            for node in sg.get("nodes", []) or []:
                if isinstance(node, dict) and "id" in node and node.get("title"):
                    titles.setdefault(str(node["id"]), str(node["title"]))
    return titles


def _find_negative_node_ids(prompt_json: Dict[str, Any]) -> set:
    """Trace upstream from any 'negative' input to identify negative prompt nodes."""
    neg_ids = set()
    queue = []
    for nid, node in prompt_json.items():
        if not isinstance(node, dict):
            continue
        inputs = node.get("inputs") or {}
        for k, v in inputs.items():
            if "neg" in k.lower() and isinstance(v, list) and len(v) >= 1:
                src = str(v[0])
                if src not in neg_ids:
                    neg_ids.add(src)
                    queue.append(src)
    # Walk up 3 hops
    hops = 0
    while queue and hops < 4:
        hops += 1
        next_q = []
        for cid in queue:
            cnode = prompt_json.get(cid)
            if not isinstance(cnode, dict):
                continue
            for v in (cnode.get("inputs") or {}).values():
                if isinstance(v, list) and len(v) >= 1:
                    src = str(v[0])
                    if src not in neg_ids:
                        neg_ids.add(src)
                        next_q.append(src)
        queue = next_q
    return neg_ids


def _clean_model_name(val: str) -> str:
    return val.replace("\\", "/").strip()


def _normalize_for_recipe(obj: Any) -> Any:
    if isinstance(obj, dict):
        out = {}
        for k in sorted(obj.keys()):
            kl = k.lower()
            if kl in VOLATILE_KEYS or kl.endswith("_seed"):
                continue
            out[k] = _normalize_for_recipe(obj[k])
        return out
    if isinstance(obj, list):
        return [_normalize_for_recipe(x) for x in obj]
    return obj


def compute_recipe_hash(prompt_json: Optional[Dict[str, Any]]) -> Optional[str]:
    if not isinstance(prompt_json, dict) or not prompt_json:
        return None
    norm = _normalize_for_recipe(prompt_json)
    raw = json.dumps(norm, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16]


def compute_workflow_fingerprint(
    prompt_json: Optional[Dict[str, Any]],
    workflow_json: Optional[Dict[str, Any]] = None,
) -> Tuple[Optional[str], Optional[str]]:
    if not isinstance(prompt_json, dict) or not prompt_json:
        return None, None
    class_types = sorted(
        str(n.get("class_type", ""))
        for n in prompt_json.values()
        if isinstance(n, dict) and n.get("class_type")
    )
    if not class_types:
        return None, None
    sig = "|".join(class_types)
    wf_hash = hashlib.sha256(sig.encode("utf-8")).hexdigest()[:12]

    # 1. Try to extract meaningful workflow name from workflow_json
    label = None
    if isinstance(workflow_json, dict):
        extra = workflow_json.get("extra", {})
        if isinstance(extra, dict):
            for k in ("workflow_name", "title", "name"):
                v = extra.get(k)
                if isinstance(v, str) and len(v.strip()) > 1:
                    label = v.strip()
                    break
        if not label:
            nodes = workflow_json.get("nodes", [])
            if isinstance(nodes, list):
                for n in nodes:
                    if not isinstance(n, dict):
                        continue
                    ctype = str(n.get("type", "")).lower()
                    wv = n.get("widgets_values", [])
                    if isinstance(wv, list) and wv and isinstance(wv[0], str):
                        m = re.search(r"【(.*?)】", wv[0])
                        if m and len(m.group(1).strip()) > 2:
                            label = m.group(1).strip()
                            break
                    if "note" in ctype:
                        t = str(n.get("title", "")).strip()
                        if t and "note" not in t.lower() and len(t) > 3:
                            label = t
                            break

    # 2. Heuristic fallback
    if not label:
        joined = " ".join(class_types).lower()
        if "wanvideo" in joined or "vhs_videocombine" in joined or "savevideo" in joined:
            if "wan" in joined:
                label = "WanVideo"
            elif "ltx" in joined:
                label = "LTX Video"
            else:
                label = "Video Workflow"
        elif "minimax" in joined:
            label = "MiniMax Workflow"
        elif "qwen" in joined and "tile" in joined:
            label = "Qwen Tiled Upscale"
        elif "flux" in joined:
            label = "Flux Workflow"
        elif "ultimatesdupscale" in joined or "imagedetailer" in joined or "facedetailer" in joined:
            label = "Upscale / Detailer"
        else:
            label = f"Workflow ({len(class_types)} nodes)"
    return wf_hash, label


def parse_comfy_metadata(
    prompt_json: Optional[Dict[str, Any]],
    workflow_json: Optional[Dict[str, Any]] = None,
    raw_parameters: Optional[str] = None,
) -> Dict[str, Any]:
    """Parse ComfyUI prompt & workflow JSON into structured prompts, models, LoRAs, and params."""
    prompts: List[Dict[str, Any]] = []
    models: List[Dict[str, Any]] = []
    loras: List[Dict[str, Any]] = []
    params: Dict[str, Any] = {}
    seed_targets: List[Dict[str, Any]] = []
    param_targets: Dict[str, Dict[str, Any]] = {}

    if not isinstance(prompt_json, dict) or not prompt_json:
        # A1111 fallback if present
        if raw_parameters:
            prompts.append(
                {
                    "node_id": "a1111",
                    "node_title": "Parameters",
                    "class_type": "A1111",
                    "input_key": "parameters",
                    "role": "positive",
                    "text": raw_parameters,
                }
            )
        return {
            "prompts": prompts,
            "models": models,
            "loras": loras,
            "params": params,
            "seed_targets": seed_targets,
            "param_targets": param_targets,
            "base_model": None,
            "model_family": None,
            "primary_prompt": prompts[0]["text"] if prompts else "",
            "all_prompts_text": "\n".join(p["text"] for p in prompts),
            "recipe_hash": None,
            "workflow_hash": None,
            "workflow_name": None,
        }

    ui_titles = _build_ui_title_map(workflow_json)
    neg_ids = _find_negative_node_ids(prompt_json)

    for nid, node in prompt_json.items():
        if not isinstance(node, dict):
            continue
        class_type = str(node.get("class_type") or "")
        ct_lower = class_type.lower()
        inputs = node.get("inputs") or {}
        if not isinstance(inputs, dict):
            continue
        meta_title = (node.get("_meta") or {}).get("title")
        node_title = str(meta_title or ui_titles.get(str(nid)) or class_type)

        # 1. Extract Prompts (multi-node aware)
        is_text_node = any(
            kw in ct_lower
            for kw in (
                "cliptextencode",
                "textencode",
                "prompt",
                "string",
                "wildcard",
                "multiline",
                "showtext",
                "florence",
                "qwen",
                "minimax",
                "t5",
            )
        )
        for k, v in inputs.items():
            if not isinstance(v, str):
                continue
            val = v.strip()
            if not val:
                continue
            kl = k.lower()
            if kl in TEXT_INPUT_KEYS or (is_text_node and kl in ("value", "input", "content", "prefix", "suffix")):
                if FILE_EXT_RE.search(val) and "\n" not in val and len(val) < 120:
                    continue
                if len(val) < 2:
                    continue
                role = "prompt"
                title_l = node_title.lower()
                if "neg" in kl or "neg" in title_l or str(nid) in neg_ids:
                    role = "negative"
                elif "sys" in kl or "sys" in title_l:
                    role = "system"
                elif "upscale" in title_l or "皮肤" in node_title or "detail" in title_l:
                    role = "upscale"
                elif "pos" in kl or "pos" in title_l or "cliptextencode" in ct_lower or kl == "prompt":
                    role = "positive"

                prompts.append(
                    {
                        "node_id": str(nid),
                        "node_title": node_title,
                        "class_type": class_type,
                        "input_key": k,
                        "role": role,
                        "text": val,
                    }
                )

        # 2. Extract LoRAs
        if "lora" in ct_lower:
            # Standard LoraLoader / LoraLoaderModelOnly / WanVideoLoraSelect
            if "lora_name" in inputs and isinstance(inputs["lora_name"], str) and inputs["lora_name"].lower() != "none":
                sm = inputs.get("strength_model", inputs.get("strength", 1.0))
                sc = inputs.get("strength_clip", sm)
                loras.append(
                    {
                        "node_id": str(nid),
                        "node_title": node_title,
                        "class_type": class_type,
                        "mode": "standard",
                        "key_name": "lora_name",
                        "key_strength_model": "strength_model" if "strength_model" in inputs else "strength",
                        "key_strength_clip": "strength_clip" if "strength_clip" in inputs else None,
                        "name": _clean_model_name(inputs["lora_name"]),
                        "strength_model": float(sm) if isinstance(sm, (int, float)) else 1.0,
                        "strength_clip": float(sc) if isinstance(sc, (int, float)) else 1.0,
                        "enabled": True,
                    }
                )
            elif "lora" in inputs and isinstance(inputs["lora"], str) and inputs["lora"].lower() != "none":
                sm = inputs.get("strength", inputs.get("strength_model", 1.0))
                loras.append(
                    {
                        "node_id": str(nid),
                        "node_title": node_title,
                        "class_type": class_type,
                        "mode": "standard",
                        "key_name": "lora",
                        "key_strength_model": "strength" if "strength" in inputs else "strength_model",
                        "key_strength_clip": None,
                        "name": _clean_model_name(inputs["lora"]),
                        "strength_model": float(sm) if isinstance(sm, (int, float)) else 1.0,
                        "strength_clip": float(sm) if isinstance(sm, (int, float)) else 1.0,
                        "enabled": True,
                    }
                )

            # Power Lora Loader (rgthree): lora_1 = {"on": True, "lora": "...", "strength": 0.8}
            for k, v in inputs.items():
                if isinstance(v, dict) and "lora" in v and isinstance(v.get("lora"), str):
                    lname = v.get("lora", "")
                    if lname and lname.lower() != "none":
                        enabled = bool(v.get("on", True))
                        sm = v.get("strength", 1.0)
                        sc = v.get("strengthTwo", sm)
                        loras.append(
                            {
                                "node_id": str(nid),
                                "node_title": node_title,
                                "class_type": class_type,
                                "mode": "rgthree",
                                "key_name": k,
                                "key_strength_model": k,
                                "key_strength_clip": k,
                                "name": _clean_model_name(lname),
                                "strength_model": float(sm) if isinstance(sm, (int, float)) else 1.0,
                                "strength_clip": float(sc) if isinstance(sc, (int, float)) else 1.0,
                                "enabled": enabled,
                            }
                        )

            # Stack style: lora_name_1 / model_weight_1 / clip_weight_1
            for k, v in inputs.items():
                m = re.match(r"^(?:lora_name|lora)_(\d+)$", k)
                if m and isinstance(v, str) and v.lower() != "none" and v.strip():
                    idx = m.group(1)
                    sm_key = next(
                        (cand for cand in (f"strength_model_{idx}", f"model_weight_{idx}", f"lora_wt_{idx}", f"strength_{idx}") if cand in inputs),
                        None,
                    )
                    sc_key = next(
                        (cand for cand in (f"strength_clip_{idx}", f"clip_weight_{idx}") if cand in inputs),
                        None,
                    )
                    sw_key = next((cand for cand in (f"switch_{idx}", f"on_{idx}") if cand in inputs), None)
                    enabled = True
                    if sw_key is not None:
                        sw_val = inputs[sw_key]
                        enabled = str(sw_val).lower() not in ("off", "false", "0")
                    sm = inputs.get(sm_key, 1.0) if sm_key else 1.0
                    sc = inputs.get(sc_key, sm) if sc_key else sm
                    loras.append(
                        {
                            "node_id": str(nid),
                            "node_title": node_title,
                            "class_type": class_type,
                            "mode": "stack",
                            "key_name": k,
                            "key_strength_model": sm_key,
                            "key_strength_clip": sc_key,
                            "name": _clean_model_name(v),
                            "strength_model": float(sm) if isinstance(sm, (int, float)) else 1.0,
                            "strength_clip": float(sc) if isinstance(sc, (int, float)) else 1.0,
                            "enabled": enabled,
                        }
                    )

        # 3. Extract Models (Checkpoint, UNET/Diffusion, CLIP, VAE, ControlNet, Upscaler)
        for k, v in inputs.items():
            if not isinstance(v, str) or not v.strip() or v.lower() == "none":
                continue
            kl = k.lower()
            cat = None
            if kl in ("ckpt_name", "checkpoint", "checkpoint_name"):
                cat = "checkpoint"
            elif kl in ("unet_name", "diffusion_model", "gguf_name") or (
                kl == "model_name"
                and ("unet" in ct_lower or "diffusion" in ct_lower or "gguf" in ct_lower or "wan" in ct_lower)
                and not any(x in v.lower() for x in ("depth_anything", "dwpose", "yolox", "sam_", "vit", "openpose", "mediapipe"))
            ):
                cat = "unet"
            elif kl.startswith("clip_name") or kl in ("text_encoder", "t5_name"):
                cat = "clip"
            elif kl in ("vae_name", "vae"):
                cat = "vae"
            elif kl in ("control_net_name", "controlnet_name"):
                cat = "controlnet"
            elif kl == "model_name" and ("upscale" in ct_lower or "esrgan" in v.lower() or "4x" in v.lower()):
                cat = "upscaler"
            elif "ipadapter" in ct_lower and "file" in kl:
                cat = "ipadapter"

            if cat:
                models.append(
                    {
                        "node_id": str(nid),
                        "node_title": node_title,
                        "class_type": class_type,
                        "input_key": k,
                        "category": cat,
                        "name": _clean_model_name(v),
                    }
                )

        # 4. Extract Sampler / Generation Parameters & Seed targets
        for k, v in inputs.items():
            kl = k.lower()
            if isinstance(v, (list, dict)):
                continue
            if kl in ("seed", "noise_seed", "seed_num", "random_seed") and isinstance(v, (int, float)):
                seed_targets.append(
                    {
                        "node_id": str(nid),
                        "node_title": node_title,
                        "class_type": class_type,
                        "input_key": k,
                        "value": int(v),
                    }
                )
                if "seed" not in params:
                    params["seed"] = int(v)
                    param_targets["seed"] = {"node_id": str(nid), "input_key": k}
            elif kl == "steps" and isinstance(v, (int, float)) and "steps" not in params:
                params["steps"] = int(v)
                param_targets["steps"] = {"node_id": str(nid), "input_key": k}
            elif kl in ("cfg", "cfg_scale") and isinstance(v, (int, float)) and "cfg" not in params:
                params["cfg"] = round(float(v), 3)
                param_targets["cfg"] = {"node_id": str(nid), "input_key": k}
            elif kl == "guidance" and isinstance(v, (int, float)) and "guidance" not in params:
                params["guidance"] = round(float(v), 3)
                param_targets["guidance"] = {"node_id": str(nid), "input_key": k}
            elif kl in ("sampler_name", "sampler") and isinstance(v, str) and "sampler" not in params:
                params["sampler"] = v
                param_targets["sampler"] = {"node_id": str(nid), "input_key": k}
            elif kl == "scheduler" and isinstance(v, str) and "scheduler" not in params:
                params["scheduler"] = v
                param_targets["scheduler"] = {"node_id": str(nid), "input_key": k}
            elif kl == "denoise" and isinstance(v, (int, float)) and "denoise" not in params:
                params["denoise"] = round(float(v), 3)
                param_targets["denoise"] = {"node_id": str(nid), "input_key": k}
            elif kl == "width" and isinstance(v, int) and v >= 64 and "width" not in params:
                if "latent" in ct_lower or "image" in ct_lower or "size" in ct_lower or "empty" in ct_lower or "wan" in ct_lower or "minimax" in ct_lower:
                    params["width"] = v
                    param_targets["width"] = {"node_id": str(nid), "input_key": k}
            elif kl == "height" and isinstance(v, int) and v >= 64 and "height" not in params:
                if "latent" in ct_lower or "image" in ct_lower or "size" in ct_lower or "empty" in ct_lower or "wan" in ct_lower or "minimax" in ct_lower:
                    params["height"] = v
                    param_targets["height"] = {"node_id": str(nid), "input_key": k}
            elif kl in ("length", "num_frames", "frame_count") and isinstance(v, int) and "frames" not in params:
                params["frames"] = v
                param_targets["frames"] = {"node_id": str(nid), "input_key": k}
            elif kl in ("frame_rate", "fps") and isinstance(v, (int, float)) and "fps" not in params:
                params["fps"] = float(v)
                param_targets["fps"] = {"node_id": str(nid), "input_key": k}

    # Determine primary base model
    base_model = None
    for pref in ("checkpoint", "unet"):
        found = next((m["name"] for m in models if m["category"] == pref), None)
        if found:
            base_model = found
            break

    # Sort prompts: positive first, then prompt, upscale, system, negative last
    role_order = {"positive": 0, "prompt": 1, "upscale": 2, "system": 3, "negative": 4}
    prompts.sort(key=lambda p: (role_order.get(p["role"], 9), p["node_id"]))

    primary_prompt = next((p["text"] for p in prompts if p["role"] in ("positive", "prompt")), "")
    if not primary_prompt and prompts:
        primary_prompt = prompts[0]["text"]
    all_prompts_text = "\n".join(p["text"] for p in prompts)

    recipe_hash = compute_recipe_hash(prompt_json)
    workflow_hash, workflow_name = compute_workflow_fingerprint(prompt_json, workflow_json)

    return {
        "prompts": prompts,
        "models": models,
        "loras": loras,
        "params": params,
        "seed_targets": seed_targets,
        "param_targets": param_targets,
        "base_model": base_model,
        "model_family": classify_model_family(base_model),
        "primary_prompt": primary_prompt,
        "all_prompts_text": all_prompts_text,
        "recipe_hash": recipe_hash,
        "workflow_hash": workflow_hash,
        "workflow_name": workflow_name,
    }


MODEL_FAMILY_RULES: List[Tuple[str, str]] = [
    (r"krea\s*2|kera\s*2|krealism|realismbystableyogi|fineporn", "Krea2"),
    (r"qwen[\s_-]*image[\s_-]*2\.1", "Qwen-Image 2.1"),
    (r"qwen[\s_-]*image[\s_-]*2\.0|qwen[\s_-]*image[\s_-]*2\b", "Qwen-Image 2.0"),
    (r"qwen[\s_-]*image", "Qwen-Image"),
    (r"\bmoss\b|moss[\s_-]*image", "MOSS"),
    (r"minimax[\s_-]*h3", "MiniMax H3"),
    (r"minimax", "MiniMax"),
    (r"z[\s_-]*image", "Z-Image"),
    (r"fibo\s*2", "Fibo2"),
    (r"wan[\s_-]*2\.2", "Wan 2.2"),
    (r"wan[\s_-]*2\.1", "Wan 2.1"),
    (r"\bwan\b|wan[\s_-]*video", "Wan"),
    (r"ltx[\s_-]*2\.3", "LTX-2.3"),
    (r"ltx[\s_-]*2", "LTX-2"),
    (r"\bltx\b|ltxv", "LTX"),
    (r"flux[\s._-]*2", "Flux.2"),
    (r"flux[\s._-]*1|flux[\s._-]*(dev|schnell|kontext|krea)|^flux", "Flux.1"),
    (r"boogu", "Boogu"),
    (r"shuttle[\s_-]*3", "Shuttle-3"),
    (r"redcraft", "Redcraft"),
    (r"hunyuan", "Hunyuan"),
    (r"hidream", "HiDream"),
    (r"chroma", "Chroma"),
    (r"kolors", "Kolors"),
    (r"sd[\s_-]*3\.5", "SD 3.5"),
    (r"illustrious|noobai", "Illustrious / SDXL"),
    (r"pony", "Pony / SDXL"),
    (r"sdxl|xl[\s_-]*base", "SDXL"),
    (r"majicmix|麦橘|sd[\s_-]*1\.5|v1-5", "SD 1.5"),
]

_PREPROCESSOR_RE = re.compile(r"depth_anything|dwpose|yolox|openpose|mediapipe|sam_vit", re.IGNORECASE)


def classify_model_family(base_model: Optional[str]) -> Optional[str]:
    """Map a concrete checkpoint/UNET variant filename (or subfolder path) to its underlying foundation model family."""
    if not base_model:
        return None
    full_norm = base_model.replace("\\", "/").strip()
    name = full_norm.split("/")[-1].strip()
    if not name or _PREPROCESSOR_RE.search(name):
        return None
    low_name = name.lower()
    low_full = full_norm.lower()
    for pattern, label in MODEL_FAMILY_RULES:
        if re.search(pattern, low_name) or re.search(pattern, low_full):
            return label
    # Fallback: strip extension and common quantization/turbo/variant suffixes
    stem = re.sub(r"\.(safetensors|ckpt|gguf|pt|pth|bin)$", "", name, flags=re.IGNORECASE)
    stem = re.sub(
        r"[\s_-]*(turbo|fp8|fp16|bf16|int8|int4|nvfp4|scaled|convrot|pruned|e4m3fn|e5m2|distilled|dev|raw|native|kj|hd|v\d+(?:\.\d+)?)\b",
        "",
        stem,
        flags=re.IGNORECASE,
    )
    stem = re.sub(r"[\s_-]+", " ", stem).strip()
    return stem[:32] if stem else None
