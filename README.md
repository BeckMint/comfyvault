<div align="center">

# ComfyVault `v0.1.64`

**The All-in-One Local Studio for ComfyUI: Virtualized Gallery, 3-Engine AI Reverse-Prompter, Multi-Ref Split/Grid Compare, Visual Workflow Launcher & Live VRAM/RAM Guard**

![Version](https://img.shields.io/badge/version-0.1.64-indigo) ![License](https://img.shields.io/badge/license-MIT-emerald) ![Local-First](https://img.shields.io/badge/100%25-Local--First-sky) ![Bilingual](https://img.shields.io/badge/UI-EN%20%7C%20%E4%B8%AD%E6%96%87-violet)

[English](README.md) · [简体中文](README_ZH.md)

<br/>

![ComfyVault Screenshot](docs/screenshot.jpg)

</div>

---

## Why ComfyVault?

Running ComfyUI at scale quickly turns `ComfyUI/output/` and `workflows/` into chaos. **ComfyVault** runs quietly alongside ComfyUI at `http://127.0.0.1:8189` and turns your local setup into a fast, zero-cloud creative studio:

| Common ComfyUI Pain Point | How ComfyVault Solves It |
|---|---|
| **Thousands of images & videos buried in `output/`** | Smooth virtualized gallery with WebP thumbnails, live `watchdog` indexing, PyAV MP4/WebM metadata recovery, faceted search, and Seed Recipe grouping. |
| **200+ text-only `.json` workflow files** | Visual Workflow Launcher with **custom drag/upload/`Ctrl+V` workflow icons**, pinned workflows, pinned nodes, and remembered prompt box heights. |
| **Reverse-prompting a reference photo overwrites your LoRA character** | **3-Engine AI Reverse-Prompter** (Gemini Web, ChatGPT Web, **Offline Uncensored Local Qwen3-VL**) with `------` character-lock awareness, camera/pose/lighting fidelity lock, and auto aspect-ratio matching. |
| **Can't tell how closely an output matched the reference(s)** | **1-Click Reference vs Output Compare**: auto-detects both reverse-prompt references *and* workflow `LoadImage` inputs — **Side-by-Side / Slider** for 1 ref, **N-Grid** for multi-ref! |
| **Video jobs silently swap to disk & crawl for hours** | **Live VRAM / RAM / Step-Stall Monitor** with highlighted alert banner above the progress bar + 1-click Abort, and an anti-misclick 2-step Stop button. |

---

## Highlights & Key Features

### 1. 3-Engine AI Reverse-Prompter & Inline Prompt Writer
- **Three Engines, Zero Extra API Bills**:
  - **Gemini Web** & **ChatGPT Web**: Reuse your existing web subscription via a persistent local browser profile (auto session reuse with unique per-turn markers so replies never mix).
  - **Local Qwen3-VL (Offline & Uncensored)**: Calls ComfyUI's local `AILab_QwenVL_Advanced` node completely offline, with automatic VRAM unload after inference.
- **Vision Reverse-Prompting**: Drag-and-drop, upload, or `Ctrl+V` paste any reference photo. ComfyVault automatically locks **first-sentence camera angle & visual perspective**, **pose anatomy**, **LoRA-resistant expressions**, **cast-shadow placement**, and **automatically matches your workflow's aspect ratio / latent resolution node** to the reference image.
- **Character-Locked Template (`------`) Support**: Detects `------` dividers in your main prompt, preserves your fixed character trigger block untouched, and writes only scene/pose/wardrobe/lighting paragraphs (omitting reference face, body proportions, watermarks, and aspect-ratio words).
- **Inline `AI Write` on Every Prompt Box**: Every prompt field in both *Create Workflow* and *Remix* modals includes an **`AI Write`** button that auto-detects your current workflow's **base model** (Krea2, Qwen-Image, MOSS, MiniMax H3, Wan 2.2, LTX-2.3, Flux.2, SDXL, etc.) and **Image vs Video** medium, shows a live step progress bar, and outputs into a dedicated copy/apply box.

### 2. Reference vs Output Split & Multi-Ref N-Grid Comparison
- **Automatic Reference Discovery**: Works for **both** AI reverse-prompted generations *and* any workflow using `LoadImage` nodes (Style Transfer, I2I, I2V, ControlNet, IP-Adapter, Qwen-Image-Edit) — including all your existing historical outputs!
- **Smart Adaptive Layout**:
  - **1 Reference Image**: Opens in **Side-by-Side Split** with **Overlay Slider** and **100% Zoom Scroll**.
  - **Multiple Reference Images**: Opens in an **N-Grid** ordered from Reference 1 → Reference K → **Generated Output highlighted in the last tile** (with 1v1 switcher if you want to inspect any single reference closely).
- Accessible in 1 click from gallery cards (hover-expanding badge), the right inspector drawer (with multi-ref mini thumbnails), and the full-screen Lightbox.

### 3. Visual Workflow Launcher, Custom Icons & Full Node Editor
- **Custom Workflow Icons**: Click the left icon slot on any workflow in *Create* or *Convert* lists to open the icon modal — **drag, upload, or `Ctrl+V` paste** any image to auto-crop into a crisp `160×160` WebP avatar synced across both lists.
- **Full Editable Node Forms (Online & Offline)**: Scans multiple `.json` workflow directories (UI & API formats, including ComfyUI V3 dynamic combos). Pin favorite workflows and pin frequently edited nodes inside each workflow.
- **Persistent Prompt Box Heights**: Resize any prompt textarea and ComfyVault remembers your preferred height per workflow and node.
- **Interactive Power LoRA Editor**: Add, remove, reorder, toggle, and fine-tune LoRAs with `0.01`-precision sliders and auto-detected min/max ranges from `.civitai.info`, `.metadata.json`, `.rgthree-info.json`, and usage history.
- **Atomic Save Back**: Save edited prompts, LoRAs, and parameters directly back into your `.json` workflow file without closing the modal.

### 4. Live Resource Guard, Anomaly Alerts & Accurate Gen Timing
- **Real-Time VRAM / RAM / Stall Monitor**: Polls Windows RAM, Commit Charge, GPU VRAM, and per-step sampling speed every 2.5 seconds during execution, displaying live `VRAM % · RAM %` pills on the progress bar.
- **Highlighted Anomaly Alert Banner**: If RAM hits critical pressure (`≥ 85% / 92%`), VRAM+RAM saturate together, or a sampling step stalls (`≥ 90s / 180s`), a high-visibility **Warning / Critical bar** appears directly above the progress bar explaining the issue with a **1-click Abort Task** button.
- **Anti-Misclick Stop Control**: The progress bar's Stop button sits on the **left** (far away from top-right *Create*) and requires a **3-second two-step confirmation** so a mouse slip never kills a 15-minute video render.
- **Exact Generation Time vs Video Length**: Reads exact millisecond `execution_start → execution_success` duration from ComfyUI `/history` (preserved across disk rescans and restarts) and displays **Gen Time** (e.g. `18m 53s`) separately from **Video Length** (`10.12s · 24fps`).

### 5. Virtualized Video-First Gallery, PyAV Metadata & WebGL2 Darkroom
- **Video-Friendly Playback**: Video cards feature a centered **Play / Pause** button (clicking anywhere else selects without playing), right-drawer previews never autoplay, **all videos play once without looping**, and global mutual exclusion guarantees at most one video plays at a time (auto-pausing whenever any modal opens).
- **Zero-Stub Media Integrity**: Built-in **PyAV** fast MP4/WebM metadata extraction & completeness guard + deferred indexing while ComfyUI is actively writing prevents half-written `48 B` video stubs or `512×512` placeholder thumbnails.
- **WebGL2 Hardware-Accelerated Lightbox**: Smooth darkroom zoom up to 400%, drag pan, and lossless 3D rotate/flip (`Q`/`E`/`H`/`V`) that preserves embedded PNG metadata on auto-save.
- **Faceted Filtering, Seed Recipes & A/B Diff**: Filter by directory tree, model family, LoRA, checkpoint, workflow hash, ComfyUI version, rating, pick/reject flags, and tags; collapse seed batches; or run split-slider A/B visual + prompt/LoRA/parameter diffs.

### 6. Non-Destructive Remix, Bilingual UI & Windows Tray Launcher
- **One-Click Reroll & Remix**: Tweak prompts, LoRAs, or parameters from any indexed image or video and queue directly to ComfyUI while preserving parent/child lineage and reference links across restarts.
- **Instant ZH / EN Bilingual UI**, Dark / Light themes, and 4-level global font scaling.
- **Windows System Tray Launcher (`launcher/ComfyUILauncher.cs`)**: Bilingual tray app to **Open / Start / Restart / Stop** both **ComfyVault (8189)** and **ComfyUI** (auto-detects `--port` in `run_nvidia_gpu.bat`).

---

## Quick Start & Installation

> **No Node.js required for normal use!** The compiled frontend (`frontend/dist`) is pre-bundled in the repository — just install Python dependencies and run.

### Prerequisites
- An existing **ComfyUI** installation (Python 3.10–3.13; battle-tested on `ComfyUI_windows_portable`)
- **Git** (or download the repository as a `.zip`)
- **Microsoft Edge** or **Google Chrome** *(optional — only needed for Gemini/ChatGPT web prompt conversion)*

---

### Option A: ComfyUI Windows Portable (Recommended)

#### 1. Clone ComfyVault into your `ComfyUI_windows_portable` root folder
```text
ComfyUI_windows_portable/
├── ComfyUI/
├── python_embeded/
├── run_nvidia_gpu.bat
└── ComfyVault/          <-- clone here
```

```powershell
git clone https://github.com/BeckMint/comfyvault.git ComfyVault
```

#### 2. Install Python dependencies (using ComfyUI's embedded Python)
```powershell
.\python_embeded\python.exe -m pip install aiohttp watchdog pillow pyyaml
```

*(Optional — only if you want Gemini / ChatGPT web prompt conversion:)*
```powershell
.\python_embeded\python.exe -m pip install playwright
```

#### 3. Launch ComfyVault
```powershell
cd ComfyVault
..\python_embeded\python.exe -s run_vault.py
```
*(Or double-click `ComfyVault\start_vault.bat`.)*

Open **`http://127.0.0.1:8189/`** in your browser! ComfyVault automatically scans `ComfyUI/output` and `ComfyUI/user/default/workflows`. Add more gallery or workflow folders anytime in **Settings (gear icon)**.

---

### Option B: Standard Python venv / Linux / macOS

```bash
git clone https://github.com/BeckMint/comfyvault.git ComfyVault
pip install aiohttp watchdog pillow pyyaml
# Optional: for Gemini / ChatGPT web prompt converter
# pip install playwright
cd ComfyVault
python run_vault.py
```

Open **`http://127.0.0.1:8189/`** and configure your output/workflow directories in **Settings** if ComfyUI lives in another path.

---

### Updating ComfyVault
```bash
cd ComfyVault
git pull
```
Then restart `run_vault.py` and hard-refresh the browser (`Ctrl+F5`).

### Optional: Compile the Windows System Tray Launcher (ZH / EN)
Run from inside `ComfyVault\` (uses Windows' built-in .NET compiler — no Visual Studio needed):

```powershell
C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe `
  /nologo /target:winexe /utf8output /optimize+ `
  /out:..\ComfyUI启动器.exe `
  /r:System.Windows.Forms.dll /r:System.Drawing.dll `
  launcher\ComfyUILauncher.cs
```

### Optional: Rebuilding the Frontend (For Developers)
Only needed if you edit files under `frontend/src/` (requires Node.js 18+):
```bash
cd ComfyVault/frontend
npm install
npm run build
```

---

## Configuration & Environment Variables

| Variable | Default | Description |
|---|---|---|
| `COMFYVAULT_HOST` | `127.0.0.1` | Host interface for ComfyVault server |
| `COMFYVAULT_PORT` | `8189` | Port for ComfyVault Web UI |
| `COMFYUI_HOST` | `127.0.0.1` | ComfyUI server host |
| `COMFYUI_PORT` | `8188` *(auto-detected)* | ComfyUI server port (auto-detects `--port <N>` in `run_nvidia_gpu.bat`) |

---

## Privacy & Security
- Runs **100% locally** (`127.0.0.1`) with zero telemetry or cloud accounts required.
- Your SQLite database (`data/vault.db`), cached WebP thumbnails (`data/thumbs/`), custom workflow icons (`data/workflow_icons/`), reference images (`data/ref_images/`), and optional browser login profile (`data/web_llm_profile/`) stay exclusively inside `ComfyVault/data/` and are ignored by `.gitignore`.

## License
Released under the [MIT License](LICENSE).
