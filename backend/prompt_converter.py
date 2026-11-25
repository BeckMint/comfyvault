import base64
import json
import mimetypes
import os
import re
import subprocess
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from .config import DATA_DIR

WEB_LLM_PROFILE_DIR = DATA_DIR / "web_llm_profile"
WEB_LLM_SESSIONS_FILE = DATA_DIR / "web_llm_sessions.json"
MAX_TURNS_PER_SESSION = 20

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
        camera_lock_block = (
            "CAMERA GEOMETRY & COMPOSITION FIDELITY (HIGHEST PRIORITY — MUST BE ACCURATELY REVERSE-ENGINEERED AND STATED IN THE OPENING PARAGRAPH):\n"
            "Do NOT default to generic 'eye-level 50mm' descriptions. Carefully measure and explicitly describe all spatial relationships between camera and subject:\n"
            "1. Exact Shot Scale & Crop Boundaries: state precisely where the frame crops the subject (e.g., close-up, chest-up, waist-up, mid-thigh, knee-up, full-body with feet visible/cropped) and how much headroom or empty space surrounds them.\n"
            "2. Camera Elevation & Vertical Pitch Relative to Subject: specify the exact camera height and tilt (e.g., ground-level worm's-eye looking sharply upward, low-angle from knee/waist level looking up, strict eye-level, slightly elevated high-angle looking down, steep overhead/top-down bird's-eye).\n"
            "3. Horizontal Viewing Angle & Subject Orientation: explicitly separate (a) camera azimuth relative to the subject (dead-on frontal, 3/4 front-left or front-right, strict side profile, over-the-shoulder, 3/4 rear view looking back, full back view), (b) torso orientation, (c) head turn angle, and (d) exact eye-gaze direction (direct eye contact with lens vs looking off-frame left/right/up/down).\n"
            "4. Subject Placement, Scale & Horizon: state where the subject sits in the frame (centered, left/right third, lower-left/upper-right, diagonal axis), approximate proportion of the frame occupied, horizon line height (low/mid/high), and any Dutch tilt / camera roll.\n"
            "5. Lens Perspective & Foreshortening: accurately reflect wide-angle close-proximity perspective/foreshortening (e.g., 20-28mm with foreground limbs/props looming larger), natural 35-50mm, or telephoto 85-135mm background compression and depth-of-field falloff.\n"
            "6. Depth Layering & Framing: note any immediate foreground occlusion/shoot-through elements (window frame, railing, foliage, table edge), leading lines, and how the background recedes behind the subject.\n"
        )
        task_block = (
            f"{camera_lock_block}\n"
            "TASK: Reverse-engineer a structured generation prompt from the attached reference image.\n"
            + (
                f"ADDITIONAL USER INSTRUCTIONS / ADJUSTMENTS (apply these modifications on top of the image):\n{src}"
                if src
                else "Analyze every meaningful visual detail of the attached image — starting with exact camera angle, perspective, and composition — and produce the prompt directly."
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
        "- Treat this request independently from any earlier messages or images in this conversation.\n"
        "- Output ONLY the converted prompt text wrapped strictly between <<<PROMPT_START>>> and <<<PROMPT_END>>>.\n"
        "- Do NOT include explanations, markdown headings, bullet lists, or extra commentary outside the markers.\n\n"
        f"{task_block}"
    )


def extract_marked_prompt(raw_text: str) -> str:
    if not raw_text:
        return ""
    matches = re.findall(r"<<<PROMPT_START>>>\s*(.*?)\s*<<<PROMPT_END>>>", raw_text, re.DOTALL)
    # Filter out the instruction echo ("and" / tiny placeholders) and pick the last real generated prompt
    valid = [m.strip() for m in matches if len(m.strip()) >= 20 and m.strip().lower() != "and"]
    if valid:
        return valid[-1]
    if matches:
        return matches[-1].strip()
    # Fallback: strip common markdown code fences
    cleaned = raw_text.strip()
    if cleaned.startswith("```"):
        cleaned = re.sub(r"^```[a-zA-Z]*\s*", "", cleaned)
        cleaned = re.sub(r"\s*```$", "", cleaned)
    return cleaned.strip()


def _detect_browser_exe() -> Optional[str]:
    candidates = [
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    ]
    for path in candidates:
        if Path(path).exists():
            return path
    return None


def _detect_browser_channel() -> Optional[str]:
    exe = _detect_browser_exe() or ""
    if "msedge.exe" in exe.lower():
        return "msedge"
    if "chrome.exe" in exe.lower():
        return "chrome"
    return None


_login_window_active = False
_progress: Dict[str, Any] = {
    "stage": "idle",
    "step": 0,
    "total_steps": 5,
    "message_zh": "",
    "message_en": "",
    "started_at": 0.0,
}


def _set_progress(
    stage: str,
    step: int = 0,
    total_steps: int = 5,
    message_zh: str = "",
    message_en: str = "",
    reset_timer: bool = False,
) -> None:
    _progress["stage"] = stage
    _progress["step"] = step
    _progress["total_steps"] = total_steps
    _progress["message_zh"] = message_zh
    _progress["message_en"] = message_en
    if reset_timer:
        _progress["started_at"] = time.time()
    elif stage == "idle":
        _progress["started_at"] = 0.0


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
        "login_open": _login_window_active,
        "stage": _progress["stage"],
        "step": _progress["step"],
        "total_steps": _progress["total_steps"],
        "message_zh": _progress["message_zh"],
        "message_en": _progress["message_en"],
        "started_at": _progress["started_at"],
    }


def reset_converter_browser_sync() -> Dict[str, Any]:
    """Force-close any lingering login/automation browser bound to WEB_LLM_PROFILE_DIR and reset status."""
    global _login_window_active
    _kill_profile_browsers()
    _login_window_active = False
    _set_progress("idle")
    time.sleep(0.4)
    return {
        "ok": True,
        "busy": _browser_lock.locked(),
        "message": "已关闭并重置本地独立浏览器进程，现在可以重新操作",
    }


def _kill_profile_browsers() -> None:
    """Terminate any lingering browser processes bound to WEB_LLM_PROFILE_DIR (Windows)."""
    if os.name != "nt":
        return
    try:
        subprocess.run(
            [
                "powershell.exe",
                "-NoProfile",
                "-Command",
                "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*web_llm_profile*' -and ($_.Name -eq 'msedge.exe' -or $_.Name -eq 'chrome.exe') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
            ],
            capture_output=True,
            timeout=5,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except Exception:
        pass


def _has_visible_profile_browsers() -> bool:
    """Return True if any Edge/Chrome process bound to WEB_LLM_PROFILE_DIR still has an open window (Windows)."""
    if os.name != "nt":
        return False
    try:
        r = subprocess.run(
            [
                "powershell.exe",
                "-NoProfile",
                "-Command",
                "$pids = (Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*web_llm_profile*' -and ($_.Name -eq 'msedge.exe' -or $_.Name -eq 'chrome.exe') }).ProcessId; if (-not $pids) { 0 } else { (Get-Process -Id $pids -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Measure-Object).Count }",
            ],
            capture_output=True,
            text=True,
            timeout=5,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        return int((r.stdout or "0").strip() or "0") > 0
    except Exception:
        return False


def open_login_browser_sync(provider: str) -> Dict[str, Any]:
    """Open a genuine, visible Edge/Chrome window bound to WEB_LLM_PROFILE_DIR via Windows ShellExecuteW."""
    global _login_window_active
    url = "https://gemini.google.com/app" if provider == "gemini" else "https://chatgpt.com/"
    WEB_LLM_PROFILE_DIR.mkdir(parents=True, exist_ok=True)
    browser_exe = _detect_browser_exe()

    # If a previous login window is still open, close it cleanly so re-clicking always opens a fresh visible window
    if _login_window_active:
        _kill_profile_browsers()
        time.sleep(0.6)

    if _browser_lock.locked() and not _login_window_active:
        return {"ok": False, "error": "当前正在执行 AI 转换任务，请稍候完成后再打开登录窗口"}

    def _run_login() -> None:
        global _login_window_active
        if not _browser_lock.acquire(timeout=4):
            return
        _login_window_active = True
        _set_progress(
            "login_open",
            0,
            0,
            f"登录浏览器已打开（{provider.upper()}），登录完成后关闭该窗口即可",
            f"Login browser open ({provider.upper()}). Close the window after signing in.",
            reset_timer=True,
        )
        try:
            if browser_exe and os.name == "nt":
                import ctypes

                # Disable Edge background mode / startup boost so closing the window exits cleanly
                params = (
                    f'--user-data-dir="{WEB_LLM_PROFILE_DIR}" '
                    f'--no-first-run --no-default-browser-check --disable-background-mode '
                    f'--disable-features=msEdgeStartupBoost --new-window "{url}"'
                )
                rc = ctypes.windll.shell32.ShellExecuteW(None, "open", browser_exe, params, None, 1)
                if rc <= 32:
                    raise RuntimeError(f"ShellExecuteW failed with code {rc}")

                # Wait briefly for Edge window to appear, then release lock promptly once the user closes it
                time.sleep(3.0)
                deadline = time.time() + 900
                closed_streak = 0
                while time.time() < deadline:
                    if not _has_visible_profile_browsers():
                        closed_streak += 1
                        if closed_streak >= 2:
                            # Clean up any lingering Edge background helper so Playwright can use the profile immediately
                            _kill_profile_browsers()
                            break
                    else:
                        closed_streak = 0
                    time.sleep(1.5)
                return

            # Fallback for non-Windows or missing system Edge/Chrome: use Playwright
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
                ctx = p.chromium.launch_persistent_context(**launch_kwargs)
                try:
                    page = ctx.pages[0] if ctx.pages else ctx.new_page()
                    page.goto(url, wait_until="domcontentloaded", timeout=30000)
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
            _login_window_active = False
            _set_progress("idle")
            _browser_lock.release()

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


def _is_signed_out_page(page: Any, provider: str) -> bool:
    """Detect whether Gemini or ChatGPT is in guest/signed-out mode (where image upload is disabled)."""
    selectors = (
        [
            '[data-test-id="sign-out-banner"]',
            'a[href*="accounts.google.com/ServiceLogin"]',
            'button:has-text("登录")',
            'button:has-text("Sign in")',
            'a:has-text("登录")',
            'a:has-text("Sign in")',
        ]
        if provider == "gemini"
        else [
            'button[data-testid="login-button"]',
            'button:has-text("登录")',
            'button:has-text("Log in")',
            'button:has-text("免费注册")',
            'button:has-text("Sign up")',
        ]
    )
    for sel in selectors:
        try:
            loc = page.locator(sel).first
            if loc.count() > 0 and loc.is_visible():
                return True
        except Exception:
            continue
    return False


def _set_best_file_input(page: Any, image_path: str) -> bool:
    """Find the best <input type='file'> on the page (preferring image-accepting inputs) and set files."""
    try:
        inputs = page.locator('input[type="file"]')
        cnt = inputs.count()
        if cnt == 0:
            return False
        best_idx = 0
        for i in range(cnt):
            try:
                acc = (inputs.nth(i).get_attribute("accept") or "").lower()
                if "image" in acc or acc == "" or "*/*" in acc:
                    best_idx = i
                    break
            except Exception:
                continue
        inputs.nth(best_idx).set_input_files(image_path)
        return True
    except Exception:
        return False


def _dismiss_overlays(page: Any) -> None:
    """Close any open Angular Material / popover backdrop (e.g. Gemini's '+' upload menu) so it doesn't intercept clicks."""
    try:
        backdrop = page.locator(".cdk-overlay-backdrop-showing, .cdk-overlay-backdrop").first
        if backdrop.count() > 0 and backdrop.is_visible():
            page.keyboard.press("Escape")
            time.sleep(0.25)
            if backdrop.count() > 0 and backdrop.is_visible():
                try:
                    backdrop.click(position={"x": 5, "y": 5}, force=True, timeout=1500)
                    time.sleep(0.25)
                except Exception:
                    pass
    except Exception:
        pass


def _attach_image_to_page(page: Any, editor: Any, image_path: str, provider: str) -> None:
    """Attach a local image file to Gemini or ChatGPT web composer using resilient multi-strategy upload."""
    p = Path(image_path)
    if not p.exists() or not p.is_file():
        raise FileNotFoundError(f"参考图片不存在: {image_path}")

    if _is_signed_out_page(page, provider):
        label = "GEMINI" if provider == "gemini" else "CHATGPT"
        raise RuntimeError(
            f"{label} 网页版尚未登录（未登录的游客模式不支持上传图片），请先点击右上角「检查/重新登录 {label}」完成登录后重试"
        )

    attached = False

    # Strategy 1: Direct <input type="file"> (works natively on ChatGPT and some Gemini views)
    if _set_best_file_input(page, str(p)):
        attached = _wait_for_attachment_preview(page, provider, timeout_sec=3.5)

    # Strategy 2: Synthetic ClipboardEvent paste directly into the composer editor (locale-independent)
    if not attached:
        try:
            _dispatch_paste_image(page, editor, str(p))
            attached = _wait_for_attachment_preview(page, provider, timeout_sec=4.0)
        except Exception:
            pass

    # Strategy 3: Click upload / '+' button, then either use newly injected <input type="file"> or file chooser
    if not attached:
        upload_btn_selectors = [
            'button[aria-label*="上传和工具"]',
            'button[aria-label*="Open upload file menu"]',
            'button[aria-label*="Upload"]',
            'button[aria-label*="Add file"]',
            'button[aria-label*="上传"]',
            'button[aria-label*="添加文件"]',
            'button[aria-label*="添加图片"]',
            'button.upload-card-button',
        ]
        menu_item_selectors = [
            'button[data-test-id="local-images-files-uploader-button"]',
            'button[data-test-id="hidden-local-image-upload-button"]',
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
                    with page.expect_file_chooser(timeout=2000) as fc_info:
                        btn.click()
                    fc_info.value.set_files(str(p))
                    attached = _wait_for_attachment_preview(page, provider, timeout_sec=4.0)
                    if attached:
                        break
                except Exception:
                    # Clicking '+' may have opened a menu & injected <input type="file"> into the DOM
                    time.sleep(0.5)
                    if _is_signed_out_page(page, provider):
                        label = "GEMINI" if provider == "gemini" else "CHATGPT"
                        raise RuntimeError(
                            f"{label} 网页版尚未登录（未登录的游客模式不支持上传图片），请先点击右上角「检查/重新登录 {label}」完成登录后重试"
                        )
                    if _set_best_file_input(page, str(p)):
                        _dismiss_overlays(page)
                        attached = _wait_for_attachment_preview(page, provider, timeout_sec=4.0)
                        if attached:
                            break
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
            except RuntimeError:
                raise
            except Exception:
                continue

    if not attached:
        raise RuntimeError(
            f"未能将参考图片上传到 {provider.upper()} 网页端，请确认已登录并可勾选「显示浏览器窗口」检查页面状态"
        )

    # Ensure any upload menu / modal overlay is closed before focusing the prompt editor
    _dismiss_overlays(page)
    # Give the web client a moment to finish uploading the image blob before typing & sending
    time.sleep(2.0)


def _fill_and_send(
    page: Any,
    editor: Any,
    text: str,
    send_selectors: List[str],
    has_image: bool = False,
) -> None:
    _dismiss_overlays(page)
    try:
        editor.click(timeout=5000)
    except Exception:
        _dismiss_overlays(page)
        try:
            editor.click(force=True, timeout=5000)
        except Exception:
            editor.evaluate("el => el.focus()")
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


def _load_sessions() -> Dict[str, Dict[str, Any]]:
    try:
        if WEB_LLM_SESSIONS_FILE.exists():
            data = json.loads(WEB_LLM_SESSIONS_FILE.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                return data
    except Exception:
        pass
    return {}


def _save_session(provider: str, url: str, turns: int) -> None:
    try:
        WEB_LLM_SESSIONS_FILE.parent.mkdir(parents=True, exist_ok=True)
        data = _load_sessions()
        data[provider] = {"url": url, "turns": turns, "updated_at": time.time()}
        WEB_LLM_SESSIONS_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception:
        pass


def _clear_session(provider: str) -> None:
    try:
        data = _load_sessions()
        if provider in data:
            del data[provider]
            WEB_LLM_SESSIONS_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception:
        pass


def _is_valid_session_url(provider: str, url: str) -> bool:
    u = (url or "").strip()
    if provider == "chatgpt":
        return "chatgpt.com/c/" in u.lower()
    if provider == "gemini":
        low = u.lower()
        idx = low.find("gemini.google.com/app/")
        if idx == -1:
            return False
        tail = u[idx + len("gemini.google.com/app/") :].split("?")[0].strip("/")
        return len(tail) >= 6
    return False


def _page_shows_session_limit(page: Any) -> bool:
    """Detect if a reused conversation hit context length limit or was deleted."""
    try:
        txt = (page.evaluate("() => (document.querySelector('main') || document.body)?.innerText || ''") or "").lower()
        limit_hints = (
            "maximum length for this conversation",
            "reached the maximum length",
            "conversation not found",
            "unable to load conversation",
            "can't find that conversation",
            "已达到此对话的最大长度",
            "达到最大长度",
            "无法加载对话",
            "找不到该对话",
            "对话不存在",
        )
        return any(h in txt for h in limit_hints)
    except Exception:
        return False


def _collect_marked_blocks_from_page(page: Any) -> List[str]:
    """DOM-agnostic scan: collect all completed <<<PROMPT_START>>>...<<<PROMPT_END>>> prompt blocks currently on page."""
    try:
        full_text = page.evaluate("() => (document.querySelector('main') || document.body)?.innerText || ''")
        if not full_text:
            return []
        matches = re.findall(r"<<<PROMPT_START>>>\s*(.*?)\s*<<<PROMPT_END>>>", full_text, re.DOTALL)
        return [m.strip() for m in matches if len(m.strip()) >= 25 and m.strip().lower() != "and"]
    except Exception:
        return []


def _extract_new_marked_from_page(page: Any, prev_blocks: List[str]) -> str:
    """Return a newly generated <<<PROMPT_START>>>...<<<PROMPT_END>>> block that was not present before sending."""
    cur = _collect_marked_blocks_from_page(page)
    if not cur:
        return ""
    if len(cur) > len(prev_blocks) or (prev_blocks and cur[-1] != prev_blocks[-1]):
        return f"<<<PROMPT_START>>>\n{cur[-1]}\n<<<PROMPT_END>>>"
    return ""


def _wait_for_stable_reply(
    page: Any,
    reply_selector: str,
    prev_count: int,
    stop_selectors: List[str],
    timeout_sec: float = 95.0,
    prev_marked_blocks: Optional[List[str]] = None,
) -> str:
    start = time.time()
    last_text = ""
    stable_since = 0.0
    marker_seen_since = 0.0
    last_marker_text = ""
    baseline_blocks = list(prev_marked_blocks or [])

    while time.time() - start < timeout_sec:
        try:
            is_generating = False
            for ssel in stop_selectors:
                try:
                    sb = page.locator(ssel).first
                    if sb.count() > 0 and sb.is_visible():
                        is_generating = True
                        break
                except Exception:
                    pass

            # 1) Universal DOM-agnostic fast path: detect a NEW <<<PROMPT_START>>>...<<<PROMPT_END>>> block
            marked = _extract_new_marked_from_page(page, baseline_blocks)
            if marked:
                if not is_generating:
                    return marked
                if marked == last_marker_text:
                    if marker_seen_since == 0.0:
                        marker_seen_since = time.time()
                    elif time.time() - marker_seen_since >= 1.5:
                        return marked
                else:
                    last_marker_text = marked
                    marker_seen_since = time.time()

            # 2) Selector-based reply tracking (for replies that omitted markers)
            loc = page.locator(reply_selector)
            cnt = loc.count()
            if cnt > prev_count:
                cur_text = (loc.nth(cnt - 1).inner_text() or "").strip()
                if cur_text:
                    if "<<<PROMPT_END>>>" in cur_text and len(extract_marked_prompt(cur_text)) >= 20 and not is_generating:
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

    if last_marker_text:
        return last_marker_text
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
    label = "GEMINI" if provider == "gemini" else "CHATGPT"
    total_steps = 5 if image_path else 4

    # If a login window was open/lingering when the user starts converting, close it automatically so they are never stuck!
    if _login_window_active:
        _kill_profile_browsers()
        time.sleep(0.6)

    if not _browser_lock.acquire(timeout=5):
        raise RuntimeError("当前已有浏览器任务正在执行，请稍候完成或点击「重置浏览器并重试」")

    try:
        from playwright.sync_api import sync_playwright

        _set_progress(
            "launching",
            1,
            total_steps,
            f"正在启动本地独立浏览器（复用 {label} 登录态）...",
            f"Launching local browser (reusing {label} session)...",
            reset_timer=True,
        )

        # Ensure no stray background Edge process holds a lock on WEB_LLM_PROFILE_DIR
        _kill_profile_browsers()

        args = [
            "--disable-blink-features=AutomationControlled",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-background-mode",
            "--disable-features=msEdgeStartupBoost",
        ]
        if not show_window:
            # Keep window off-screen instead of --start-minimized so document.visibilityState stays 'visible'
            # (ChatGPT's new React UI skips rendering assistant responses when minimized!)
            args.append("--window-position=-2400,-2400")

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

                sessions = _load_sessions()
                saved_sess = sessions.get(provider) or {}
                saved_url = str(saved_sess.get("url") or "").strip()
                saved_turns = int(saved_sess.get("turns") or 0)
                can_reuse = bool(saved_url and _is_valid_session_url(provider, saved_url) and saved_turns < MAX_TURNS_PER_SESSION)
                current_turns = saved_turns if can_reuse else 0

                if provider == "gemini":
                    home_url = "https://gemini.google.com/app"
                    target_url = saved_url if can_reuse else home_url
                    _set_progress(
                        "navigating",
                        2,
                        total_steps,
                        f"正在打开 Gemini 网页版（{'复用会话 #' + str(current_turns + 1) if can_reuse else '新建会话'}）...",
                        f"Opening Gemini Web ({'reusing chat #' + str(current_turns + 1) if can_reuse else 'new chat'})...",
                    )
                    page.goto(target_url, wait_until="domcontentloaded", timeout=30000)
                    time.sleep(2.2)
                    if "accounts.google.com" in (page.url or "").lower():
                        raise RuntimeError("Gemini 尚未登录，请先点击「检查/重新登录 GEMINI」完成一次登录")

                    editor_sel = 'div.ql-editor[contenteditable="true"], rich-textarea [contenteditable="true"], textarea'
                    if can_reuse:
                        # Verify reused conversation loaded properly & didn't hit length limit
                        reused_ok = True
                        try:
                            page.wait_for_selector(editor_sel, timeout=10000)
                        except Exception:
                            reused_ok = False
                        if not reused_ok or _page_shows_session_limit(page):
                            _clear_session("gemini")
                            current_turns = 0
                            page.goto(home_url, wait_until="domcontentloaded", timeout=30000)
                            time.sleep(2.0)

                    try:
                        page.wait_for_selector(editor_sel, timeout=18000)
                    except Exception:
                        raise RuntimeError("未检测到 Gemini 输入框（可能尚未登录或需人机验证），请先点击「检查/重新登录 GEMINI」检查")

                    reply_sel = "model-response message-content, .model-response-text, message-content"
                    prev_cnt = page.locator(reply_sel).count()
                    prev_marked = _collect_marked_blocks_from_page(page)
                    editor = page.locator(editor_sel).first
                    if image_path:
                        _set_progress(
                            "uploading_image",
                            3,
                            total_steps,
                            "正在向 Gemini 上传参考图片...",
                            "Uploading reference image to Gemini...",
                        )
                        _attach_image_to_page(page, editor, image_path, "gemini")
                    _set_progress(
                        "sending",
                        4 if image_path else 3,
                        total_steps,
                        "正在向 Gemini 发送结构化反推指令..." if image_path else "正在向 Gemini 发送转换指令...",
                        "Sending reverse-prompt instruction to Gemini..." if image_path else "Sending prompt instruction to Gemini...",
                    )
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
                    _set_progress(
                        "waiting_reply",
                        total_steps,
                        total_steps,
                        "正在等待 Gemini 分析并返回结构化提示词...",
                        "Waiting for Gemini to analyze and return structured prompt...",
                    )
                    raw_reply = _wait_for_stable_reply(
                        page,
                        reply_sel,
                        prev_cnt,
                        stop_selectors=[
                            'button[aria-label*="Stop"]',
                            'button[aria-label*="停止"]',
                        ],
                        timeout_sec=150.0 if image_path else 110.0,
                        prev_marked_blocks=prev_marked,
                    )
                    # Persist conversation URL so future runs reuse the same thread (up to MAX_TURNS_PER_SESSION)
                    time.sleep(0.5)
                    final_url = page.url or ""
                    if _is_valid_session_url("gemini", final_url):
                        _save_session("gemini", final_url, current_turns + 1)
                    return extract_marked_prompt(raw_reply)

                else:
                    # ChatGPT
                    home_url = "https://chatgpt.com/"
                    target_url = saved_url if can_reuse else home_url
                    _set_progress(
                        "navigating",
                        2,
                        total_steps,
                        f"正在打开 ChatGPT 网页版（{'复用会话 #' + str(current_turns + 1) if can_reuse else '新建会话'}）...",
                        f"Opening ChatGPT Web ({'reusing chat #' + str(current_turns + 1) if can_reuse else 'new chat'})...",
                    )
                    page.goto(target_url, wait_until="domcontentloaded", timeout=30000)
                    time.sleep(2.5)
                    url_low = (page.url or "").lower()
                    if "auth" in url_low or "login" in url_low:
                        raise RuntimeError("ChatGPT 尚未登录，请先点击「检查/重新登录 CHATGPT」完成一次登录")

                    editor_sel = '#prompt-textarea, div.ProseMirror[contenteditable="true"], div[contenteditable="true"][id="prompt-textarea"], textarea[name="prompt-textarea"]'
                    if can_reuse:
                        reused_ok = True
                        try:
                            page.wait_for_selector(editor_sel, timeout=10000)
                        except Exception:
                            reused_ok = False
                        if not reused_ok or _page_shows_session_limit(page):
                            _clear_session("chatgpt")
                            current_turns = 0
                            page.goto(home_url, wait_until="domcontentloaded", timeout=30000)
                            time.sleep(2.5)

                    try:
                        page.wait_for_selector(editor_sel, timeout=20000)
                    except Exception:
                        raise RuntimeError("未检测到 ChatGPT 输入框（可能尚未登录或触发了验证），请先点击「检查/重新登录 CHATGPT」检查")

                    reply_sel = '[data-dil-message-id], [data-message-author-role="assistant"], article[data-testid^="conversation-turn-"] .markdown, .agent-turn .markdown'
                    prev_cnt = page.locator(reply_sel).count()
                    prev_marked = _collect_marked_blocks_from_page(page)
                    editor = page.locator(editor_sel).first
                    if image_path:
                        _set_progress(
                            "uploading_image",
                            3,
                            total_steps,
                            "正在向 ChatGPT 上传参考图片...",
                            "Uploading reference image to ChatGPT...",
                        )
                        _attach_image_to_page(page, editor, image_path, "chatgpt")
                    _set_progress(
                        "sending",
                        4 if image_path else 3,
                        total_steps,
                        "正在向 ChatGPT 发送结构化反推指令..." if image_path else "正在向 ChatGPT 发送转换指令...",
                        "Sending reverse-prompt instruction to ChatGPT..." if image_path else "Sending prompt instruction to ChatGPT...",
                    )
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
                    _set_progress(
                        "waiting_reply",
                        total_steps,
                        total_steps,
                        "正在等待 ChatGPT 分析并返回结构化提示词...",
                        "Waiting for ChatGPT to analyze and return structured prompt...",
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
                        timeout_sec=150.0 if image_path else 110.0,
                        prev_marked_blocks=prev_marked,
                    )
                    time.sleep(0.5)
                    final_url = page.url or ""
                    if _is_valid_session_url("chatgpt", final_url):
                        _save_session("chatgpt", final_url, current_turns + 1)
                    return extract_marked_prompt(raw_reply)
            finally:
                try:
                    ctx.close()
                except Exception:
                    pass
    finally:
        _set_progress("idle")
        _browser_lock.release()
