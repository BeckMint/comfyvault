import base64
import mimetypes
import os
import re
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from .config import DATA_DIR

WEB_LLM_PROFILE_DIR = DATA_DIR / "web_llm_profile"

_browser_lock = threading.Lock()
_login_proc_lock = threading.Lock()

DIVIDER_RE = re.compile(r"(?m)^[ \t]*-{4,}[ \t]*$")

MODEL_GUIDES: Dict[str, str] = {
    "Krea2": (
        "Target model: Krea 2 (photorealistic cinema-grade image model). "
        "Write in natural, cohesive, richly descriptive paragraphs (2-4 short paragraphs), NOT comma-separated booru tags. "
        "Structure smoothly across: (1) framing, camera angle & lens feel, (2) subject action, pose, expression, hair & wardrobe textures, "
        "(3) environment, props & spatial depth, (4) lighting direction, color palette, film texture & storytelling mood."
    ),
    "MOSS": (
        "Target model: MOSS Image model. "
        "Write in well-structured natural language paragraphs with clear layering: subject & pose, hair & outfit material details, "
        "environment & composition, lighting & tonal mood, and narrative atmosphere. Avoid messy tag dumps."
    ),
    "Qwen-Image": (
        "Target model: Qwen-Image series. "
        "Write in clear, structured, vivid paragraphs specifying composition, subject posture & expression, hair & clothing textures, "
        "background spatial hierarchy, lighting & color grading, and editorial/cinematic mood."
    ),
    "MiniMax H3": (
        "Target model: MiniMax H3 (multimodal video/image model). "
        "Write in structured cinematic paragraphs describing camera movement/framing, continuous subject action & micro-expressions, "
        "costume & hair dynamics, environment & lighting progression, and atmospheric mood."
    ),
    "Wan": (
        "Target model: Wan 2.2 video generation model. "
        "Write in fluid cinematic paragraphs describing shot scale, camera motion, natural continuous subject movement & expression, "
        "environment details, lighting, and atmosphere."
    ),
    "LTX": (
        "Target model: LTX-2 video generation model. "
        "Write in crisp, chronological cinematic paragraphs detailing camera movement, subject action, environment, lighting, and tone."
    ),
    "Flux": (
        "Target model: Flux.2 / Flux DiT image model. "
        "Write in natural, detailed editorial paragraphs covering composition, pose & expression, hair & wardrobe, setting, lighting, and color tone."
    ),
}


def split_divider_prompt(text: str) -> Tuple[bool, str, str]:
    """Detect a ------ divider line in a prompt.
    Returns (has_divider, fixed_prefix_including_divider, editable_suffix).
    """
    if not text:
        return False, "", ""
    m = DIVIDER_RE.search(text)
    if m:
        fixed_prefix = text[: m.end()].rstrip()
        editable_suffix = text[m.end() :].lstrip("\r\n")
        return True, fixed_prefix, editable_suffix
    # Fallback: inline ------ separator
    idx = text.find("------")
    if idx != -1:
        end_idx = idx
        while end_idx < len(text) and text[end_idx] == "-":
            end_idx += 1
        fixed_prefix = text[:end_idx].rstrip()
        editable_suffix = text[end_idx:].lstrip(" \t\r\n")
        return True, fixed_prefix, editable_suffix
    return False, "", text


def choose_model_guide(model_family: Optional[str]) -> str:
    mf = (model_family or "").strip()
    if not mf:
        return (
            "Write in clean, cohesive, structured natural-language paragraphs (2-4 paragraphs) "
            "covering composition & framing, subject action & expression, hair & wardrobe, environment, lighting, color tone, and story atmosphere. "
            "Avoid raw tag spam."
        )
    low = mf.lower()
    for key, guide in MODEL_GUIDES.items():
        if key.lower() in low:
            return guide
    return (
        f"Target model: {mf}. "
        "Write in clean, cohesive, structured natural-language paragraphs covering composition, subject action & expression, "
        "hair & wardrobe details, environment, lighting, color palette, and storytelling atmosphere. Avoid raw comma tag dumps."
    )


def choose_output_language(model_family: Optional[str], lang_pref: str) -> str:
    pref = (lang_pref or "auto").lower()
    if pref == "en":
        return "English"
    if pref == "zh":
        return "Simplified Chinese (简体中文)"
    low = (model_family or "").lower()
    if any(k in low for k in ("qwen", "moss", "minimax")):
        return "Simplified Chinese (简体中文)"
    return "English"


def build_conversion_instruction(
    source_text: str,
    model_family: Optional[str],
    has_divider: bool,
    lang_pref: str = "auto",
    has_image: bool = False,
) -> str:
    guide = choose_model_guide(model_family)
    out_lang = choose_output_language(model_family, lang_pref)
    src = (source_text or "").strip()

    if has_divider:
        constraint_block = (
            "IMPORTANT MODE: Character-Locked Template (the workflow already prepends a fixed character identity trigger block before '------').\n"
            "STRICT EXCLUSIONS — YOU MUST COMPLETELY OMIT:\n"
            "1. Facial features & identity (face shape, eyes, nose, lips, skin tone, ethnicity, age, beauty adjectives).\n"
            "2. Body type & proportions (bust/chest size, waist, hips, height, build, slim/curvy descriptions).\n"
            "3. Aspect ratio, canvas orientation, or resolution (e.g. 9:16, 16:9, vertical portrait, 4K).\n"
            "MUST PRESERVE & RICHLY DEVELOP:\n"
            "- Hairstyle & hair texture/movement\n"
            "- Clothing, fabric texture, styling & accessories\n"
            "- Pose, body action, hand gestures & physical interaction\n"
            "- Facial expression, gaze direction & emotional demeanor (without describing fixed facial bone structure)\n"
            "- Camera framing, angle, lens depth & composition\n"
            "- Background environment, props, spatial layering\n"
            "- Lighting direction, shadow contrast, color palette & film texture\n"
            "- Storytelling mood & narrative tension\n"
            "Refer to the subject neutrally (e.g. 'the woman' / 'she' / '她') without re-describing her face or body."
        )
    else:
        if has_image:
            constraint_block = (
                "MODE: General Full-Prompt Image Reverse-Engineering.\n"
                "Carefully analyze the attached reference image and reverse-engineer a complete, production-ready, "
                "paragraph-structured prompt tailored to the target model. Accurately capture subject appearance, hairstyle, "
                "wardrobe & fabric textures, pose & expression, camera angle & framing, background environment & props, "
                "lighting direction, color palette, lens/film texture, and overall storytelling atmosphere."
            )
        else:
            constraint_block = (
                "MODE: General Full-Prompt Template.\n"
                "Convert the user's input into a complete, production-ready, paragraph-structured prompt tailored to the target model, "
                "preserving all key visual details and expanding brief ideas into vivid, cohesive cinematic descriptions."
            )

    if has_image:
        task_block = (
            "TASK: Reverse-engineer a structured generation prompt from the attached reference image.\n"
            + (
                f"ADDITIONAL USER INSTRUCTIONS / ADJUSTMENTS (apply these modifications on top of the image):\n{src}"
                if src
                else "Analyze every meaningful visual detail of the attached image and produce the prompt directly."
            )
        )
    else:
        task_block = f"USER INPUT TO CONVERT:\n{src}"

    return (
        "You are an expert AI image/video prompt director.\n"
        f"{guide}\n"
        f"Output language: {out_lang}.\n\n"
        f"{constraint_block}\n\n"
        "OUTPUT FORMAT RULES:\n"
        "- Output ONLY the converted prompt text wrapped strictly between <<<PROMPT_START>>> and <<<PROMPT_END>>>.\n"
        "- Do NOT include explanations, markdown headings, bullet lists, or extra commentary outside the markers.\n\n"
        f"{task_block}"
    )


def extract_marked_prompt(raw_text: str) -> str:
    if not raw_text:
        return ""
    m = re.search(r"<<<PROMPT_START>>>\s*(.*?)\s*<<<PROMPT_END>>>", raw_text, re.DOTALL)
    if m:
        return m.group(1).strip()
    # Fallback: strip common markdown code fences
    cleaned = raw_text.strip()
    if cleaned.startswith("```"):
        cleaned = re.sub(r"^```[a-zA-Z]*\s*", "", cleaned)
        cleaned = re.sub(r"\s*```$", "", cleaned)
    return cleaned.strip()


def _detect_browser_channel() -> Optional[str]:
    if Path(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe").exists():
        return "msedge"
    if Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe").exists():
        return "chrome"
    return None


def get_converter_status() -> Dict[str, Any]:
    channel = _detect_browser_channel()
    profile_exists = WEB_LLM_PROFILE_DIR.exists() and any(WEB_LLM_PROFILE_DIR.iterdir())
    try:
        import playwright  # noqa: F401
        pw_ok = True
    except Exception:
        pw_ok = False
    return {
        "playwright_installed": pw_ok,
        "browser_channel": channel,
        "profile_dir": str(WEB_LLM_PROFILE_DIR),
        "profile_initialized": profile_exists,
        "busy": _browser_lock.locked(),
    }


def open_login_browser_sync(provider: str) -> Dict[str, Any]:
    """Open a visible persistent Edge/Chrome window so the user can sign in once to Gemini or ChatGPT."""
    url = "https://gemini.google.com/app" if provider == "gemini" else "https://chatgpt.com/"
    WEB_LLM_PROFILE_DIR.mkdir(parents=True, exist_ok=True)
    channel = _detect_browser_channel()

    def _run_login() -> None:
        if not _browser_lock.acquire(blocking=False):
            return
        try:
            from playwright.sync_api import sync_playwright

            with sync_playwright() as p:
                launch_kwargs: Dict[str, Any] = {
                    "user_data_dir": str(WEB_LLM_PROFILE_DIR),
                    "headless": False,
                    "viewport": None,
                    "args": [
                        "--disable-blink-features=AutomationControlled",
                        "--no-first-run",
                        "--no-default-browser-check",
                    ],
                }
                if channel:
                    launch_kwargs["channel"] = channel
                ctx = p.chromium.launch_persistent_context(**launch_kwargs)
                try:
                    page = ctx.pages[0] if ctx.pages else ctx.new_page()
                    page.goto(url, wait_until="domcontentloaded", timeout=30000)
                    # Keep browser open until the user closes it (up to 15 min)
                    deadline = time.time() + 900
                    while time.time() < deadline:
                        if not ctx.pages:
                            break
                        try:
                            _ = ctx.pages[0].url
                        except Exception:
                            break
                        time.sleep(0.8)
                finally:
                    try:
                        ctx.close()
                    except Exception:
                        pass
        except Exception as e:
            print(f"[PromptConverter] Login browser error: {e}")
        finally:
            _browser_lock.release()

    if _browser_lock.locked():
        return {"ok": False, "error": "浏览器正在运行中（请先关闭已打开的登录窗口或等待当前转换完成）"}

    t = threading.Thread(target=_run_login, daemon=True, name=f"web-llm-login-{provider}")
    t.start()
    return {
        "ok": True,
        "message": f"已打开独立浏览器访问 {provider.upper()}，请完成登录并关闭该浏览器窗口即可保存登录态。",
    }


def _has_attachment_preview(page: Any, provider: str) -> bool:
    selectors = (
        [
            "uploader-file-preview",
            ".file-preview",
            "xap-file-preview",
            'img[src^="blob:"]',
            'img[src^="data:image"]',
            'button[aria-label*="Remove"]',
            'button[aria-label*="移除"]',
            'button[aria-label*="删除"]',
        ]
        if provider == "gemini"
        else [
            'img[src^="blob:"]',
            'img[src^="data:image"]',
            'button[aria-label*="Remove"]',
            'button[aria-label*="移除"]',
            'button[aria-label*="Delete"]',
            '[data-testid*="attachment"]',
            '[data-testid*="file-thumbnail"]',
        ]
    )
    for sel in selectors:
        try:
            loc = page.locator(sel)
            if loc.count() > 0:
                return True
        except Exception:
            continue
    return False


def _wait_for_attachment_preview(page: Any, provider: str, timeout_sec: float = 4.0) -> bool:
    deadline = time.time() + timeout_sec
    while time.time() < deadline:
        if _has_attachment_preview(page, provider):
            return True
        time.sleep(0.25)
    return False


def _dispatch_paste_image(page: Any, editor: Any, image_path: str) -> None:
    p = Path(image_path)
    raw_bytes = p.read_bytes()
    b64 = base64.b64encode(raw_bytes).decode("ascii")
    mime, _ = mimetypes.guess_type(str(p))
    if not mime or not mime.startswith("image/"):
        mime = "image/png"
    filename = p.name

    editor.click()
    time.sleep(0.2)
    editor.evaluate(
        """(el, payload) => {
            const bin = atob(payload.b64);
            const arr = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
            const file = new File([arr], payload.filename, { type: payload.mime });
            const dt = new DataTransfer();
            dt.items.add(file);
            el.focus();
            const ev = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt });
            el.dispatchEvent(ev);
        }""",
        {"b64": b64, "mime": mime, "filename": filename},
    )


def _attach_image_to_page(page: Any, editor: Any, image_path: str, provider: str) -> None:
    """Attach a local image file to Gemini or ChatGPT web composer using resilient multi-strategy upload."""
    p = Path(image_path)
    if not p.exists() or not p.is_file():
        raise FileNotFoundError(f"参考图片不存在: {image_path}")

    attached = False

    # Strategy 1: Direct <input type="file"> (works natively on ChatGPT and some Gemini views)
    try:
        file_inputs = page.locator('input[type="file"]')
        if file_inputs.count() > 0:
            file_inputs.first.set_input_files(str(p))
            attached = _wait_for_attachment_preview(page, provider, timeout_sec=3.5)
    except Exception:
        pass

    # Strategy 2: Synthetic ClipboardEvent paste directly into the composer editor (locale-independent)
    if not attached:
        try:
            _dispatch_paste_image(page, editor, str(p))
            attached = _wait_for_attachment_preview(page, provider, timeout_sec=4.0)
        except Exception:
            pass

    # Strategy 3: Click upload / '+' button and handle native file chooser
    if not attached:
        upload_btn_selectors = [
            'button[aria-label*="Open upload file menu"]',
            'button[aria-label*="Upload"]',
            'button[aria-label*="Add file"]',
            'button[aria-label*="上传"]',
            'button[aria-label*="添加文件"]',
            'button[aria-label*="添加图片"]',
            'button.upload-card-button',
        ]
        menu_item_selectors = [
            'button:has-text("Upload files")',
            'button:has-text("Upload image")',
            'button:has-text("上传文件")',
            'button:has-text("上传图片")',
            '[role="menuitem"]:has-text("Upload")',
            '[role="menuitem"]:has-text("上传")',
        ]
        for btn_sel in upload_btn_selectors:
            try:
                btn = page.locator(btn_sel).first
                if btn.count() == 0 or not btn.is_visible():
                    continue
                try:
                    with page.expect_file_chooser(timeout=2500) as fc_info:
                        btn.click()
                    fc_info.value.set_files(str(p))
                    attached = _wait_for_attachment_preview(page, provider, timeout_sec=4.0)
                    if attached:
                        break
                except Exception:
                    # Clicking '+' may have opened a popover menu with "Upload files"
                    for item_sel in menu_item_selectors:
                        try:
                            item = page.locator(item_sel).first
                            if item.count() > 0 and item.is_visible():
                                with page.expect_file_chooser(timeout=4000) as fc_info:
                                    item.click()
                                fc_info.value.set_files(str(p))
                                attached = _wait_for_attachment_preview(page, provider, timeout_sec=4.0)
                                if attached:
                                    break
                        except Exception:
                            continue
                    if attached:
                        break
            except Exception:
                continue

    if not attached:
        raise RuntimeError(
            f"未能将参考图片上传到 {provider.upper()} 网页端，请勾选「显示浏览器窗口」检查页面状态"
        )

    # Give the web client a moment to finish uploading the image blob before typing & sending
    time.sleep(2.0)


def _fill_and_send(
    page: Any,
    editor: Any,
    text: str,
    send_selectors: List[str],
    has_image: bool = False,
) -> None:
    editor.click()
    time.sleep(0.25)
    # Insert full multi-line text cleanly using keyboard.insert_text (avoids newline-submitting prematurely)
    try:
        page.keyboard.press("Control+A")
        page.keyboard.press("Backspace")
    except Exception:
        pass
    page.keyboard.insert_text(text)
    time.sleep(0.5)

    # When an image is attached, wait up to 12s for the upload to finish and the Send button to become enabled
    wait_deadline = time.time() + (12.0 if has_image else 2.5)
    while time.time() < wait_deadline:
        for sel in send_selectors:
            try:
                btn = page.locator(sel).first
                if btn.count() > 0 and btn.is_visible() and btn.is_enabled():
                    btn.click()
                    return
            except Exception:
                continue
        time.sleep(0.35)
    page.keyboard.press("Enter")


def _wait_for_stable_reply(
    page: Any,
    reply_selector: str,
    prev_count: int,
    stop_selectors: List[str],
    timeout_sec: float = 95.0,
) -> str:
    start = time.time()
    last_text = ""
    stable_since = 0.0

    while time.time() - start < timeout_sec:
        try:
            loc = page.locator(reply_selector)
            cnt = loc.count()
            if cnt > prev_count:
                cur_text = (loc.nth(cnt - 1).inner_text() or "").strip()
                is_generating = False
                for ssel in stop_selectors:
                    try:
                        sb = page.locator(ssel).first
                        if sb.count() > 0 and sb.is_visible():
                            is_generating = True
                            break
                    except Exception:
                        pass

                if cur_text:
                    # Fast exit if end marker already appeared and not generating
                    if "<<<PROMPT_END>>>" in cur_text and not is_generating:
                        return cur_text
                    if cur_text == last_text and not is_generating:
                        if stable_since == 0.0:
                            stable_since = time.time()
                        elif time.time() - stable_since >= 2.2:
                            return cur_text
                    else:
                        last_text = cur_text
                        stable_since = 0.0
        except Exception:
            pass
        time.sleep(0.6)

    if last_text:
        return last_text
    raise TimeoutError("等待网页版回复超时，请检查是否需要重新登录或存在验证提示")


def convert_via_web_llm_sync(
    provider: str,
    instruction_text: str,
    show_window: bool = False,
    image_path: Optional[str] = None,
) -> str:
    """Invoke Gemini or ChatGPT web UI using the persistent local browser profile.
    Optionally attaches a local reference image for visual reverse-prompting.
    """
    provider = (provider or "gemini").lower()
    if provider not in ("gemini", "chatgpt"):
        raise ValueError(f"不支持的引擎: {provider}")

    WEB_LLM_PROFILE_DIR.mkdir(parents=True, exist_ok=True)
    channel = _detect_browser_channel()

    if not _browser_lock.acquire(timeout=3):
        raise RuntimeError("当前已有浏览器任务正在执行，请稍候或先关闭登录窗口")

    try:
        from playwright.sync_api import sync_playwright

        args = [
            "--disable-blink-features=AutomationControlled",
            "--no-first-run",
            "--no-default-browser-check",
        ]
        if not show_window:
            args.append("--start-minimized")

        with sync_playwright() as p:
            launch_kwargs: Dict[str, Any] = {
                "user_data_dir": str(WEB_LLM_PROFILE_DIR),
                "headless": False,
                "viewport": {"width": 1280, "height": 860},
                "args": args,
            }
            if channel:
                launch_kwargs["channel"] = channel

            ctx = p.chromium.launch_persistent_context(**launch_kwargs)
            try:
                page = ctx.pages[0] if ctx.pages else ctx.new_page()

                if provider == "gemini":
                    page.goto("https://gemini.google.com/app", wait_until="domcontentloaded", timeout=30000)
                    time.sleep(2.0)
                    if "accounts.google.com" in (page.url or "").lower():
                        raise RuntimeError("Gemini 尚未登录，请先点击「登录 Gemini」在弹出浏览器中完成一次登录")

                    editor_sel = 'div.ql-editor[contenteditable="true"], rich-textarea [contenteditable="true"], textarea'
                    try:
                        page.wait_for_selector(editor_sel, timeout=18000)
                    except Exception:
                        raise RuntimeError("未检测到 Gemini 输入框（可能尚未登录或需人机验证），请先点击「登录 Gemini」检查")

                    reply_sel = "model-response message-content, .model-response-text, message-content"
                    prev_cnt = page.locator(reply_sel).count()
                    editor = page.locator(editor_sel).first
                    if image_path:
                        _attach_image_to_page(page, editor, image_path, "gemini")
                    _fill_and_send(
                        page,
                        editor,
                        instruction_text,
                        [
                            'button[aria-label*="Send"]',
                            'button[aria-label*="发送"]',
                            'button.send-button',
                        ],
                        has_image=bool(image_path),
                    )
                    raw_reply = _wait_for_stable_reply(
                        page,
                        reply_sel,
                        prev_cnt,
                        stop_selectors=[
                            'button[aria-label*="Stop"]',
                            'button[aria-label*="停止"]',
                        ],
                        timeout_sec=110.0 if image_path else 95.0,
                    )
                    return extract_marked_prompt(raw_reply)

                else:
                    # ChatGPT
                    page.goto("https://chatgpt.com/", wait_until="domcontentloaded", timeout=30000)
                    time.sleep(2.5)
                    url_low = (page.url or "").lower()
                    if "auth" in url_low or "login" in url_low:
                        raise RuntimeError("ChatGPT 尚未登录，请先点击「登录 ChatGPT」在弹出浏览器中完成一次登录")

                    editor_sel = '#prompt-textarea, div[contenteditable="true"][id="prompt-textarea"], textarea[name="prompt-textarea"]'
                    try:
                        page.wait_for_selector(editor_sel, timeout=20000)
                    except Exception:
                        raise RuntimeError("未检测到 ChatGPT 输入框（可能尚未登录或触发了验证），请先点击「登录 ChatGPT」检查")

                    reply_sel = '[data-message-author-role="assistant"]'
                    prev_cnt = page.locator(reply_sel).count()
                    editor = page.locator(editor_sel).first
                    if image_path:
                        _attach_image_to_page(page, editor, image_path, "chatgpt")
                    _fill_and_send(
                        page,
                        editor,
                        instruction_text,
                        [
                            'button[data-testid="send-button"]',
                            'button[aria-label*="Send"]',
                            'button[aria-label*="发送"]',
                        ],
                        has_image=bool(image_path),
                    )
                    raw_reply = _wait_for_stable_reply(
                        page,
                        reply_sel,
                        prev_cnt,
                        stop_selectors=[
                            'button[data-testid="stop-button"]',
                            'button[aria-label*="Stop"]',
                            'button[aria-label*="停止"]',
                        ],
                        timeout_sec=110.0 if image_path else 95.0,
                    )
                    return extract_marked_prompt(raw_reply)
            finally:
                try:
                    ctx.close()
                except Exception:
                    pass
    finally:
        _browser_lock.release()
