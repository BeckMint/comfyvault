<div align="center">

# ComfyVault `v0.1.10`

**A Local Asset Manager, Parameter Tracker, Workflow Launcher & Non-Destructive Remix Studio for ComfyUI**

![Version](https://img.shields.io/badge/version-0.1.10-indigo) ![License](https://img.shields.io/badge/license-MIT-emerald)

[English](README.md) · [简体中文](README_ZH.md)

<br/>

![ComfyVault Screenshot](docs/screenshot.jpg)

</div>

---

## What is ComfyVault?

**ComfyVault** is a fast, local-first web studio built alongside ComfyUI (`http://127.0.0.1:8189`). It turns your ComfyUI `output/` folders (and any number of additional local image/video archive folders) into a searchable, 60fps visual library — while giving you full parameter inspection, non-destructive remixing, LoRA weight analytics, direct workflow launching, and AI-powered prompt conversion.

## Key Features

### 1. High-Speed Multi-Folder Asset Library
- **Multiple Output / Gallery Directories**: Configure `ComfyUI/output` plus any number of external archive/album folders in Settings. Incremental scanning & `watchdog` live file monitoring index new generations automatically.
- **60fps Virtualized Masonry**: Handles thousands of PNG/WebP/JPG images and MP4/WebM videos smoothly with background WebP thumbnail pre-warming, hover video preview, marquee drag-selection, and batch tagging/starring/trash (safely sent to OS Recycle Bin).
- **WebGL2 Hardware-Accelerated Lightbox**: Picasa-style smooth darkroom viewer with anchor-locked zoom up to 400%, double-click 100%/fit toggle, and drag pan.
- **Smart Faceted Filtering**: Filter by physical directory tree, foundation model family (Krea2, Qwen-Image, MOSS, MiniMax H3, Flux.2, Wan 2.2, LTX-2.3, etc.), LoRA, checkpoint, workflow fingerprint, ComfyUI git version, star rating, pick/reject flags, and custom tags.
- **Seed Recipe Grouping & A/B Visual Diff**: Collapse seed variations of the same prompt/params into a single card, or select any two assets for split-slider A/B visual + prompt/LoRA/parameter comparison.

### 2. Workflow Launcher & Full Node Editor
- **Direct Workflow Creation**: Point ComfyVault to one or more local `.json` workflow directories (supports both ComfyUI UI and API JSON formats). Pin frequently used workflows and pin frequently edited nodes inside each workflow.
- **Full Editable Node Forms**: Numerically sorted `#node_id` cards with `LoadImage` thumbnail previews & direct upload to ComfyUI, plus an interactive **Power LoRA Editor** (add, delete, reorder, toggle, weight slider, and auto-detected per-LoRA min/max limits from `.civitai.info`, `.metadata.json`, `.rgthree-info.json`, and usage history).
- **Save Back to Workflow**: Save edited parameters & prompts back into workflow files atomically without closing the modal.

### 3. Non-Destructive Remix & Live ComfyUI Bridge
- **One-Click Reroll & Remix**: Open any indexed asset in the Remix modal to tweak prompts, LoRAs, or any node parameter and queue directly to ComfyUI while keeping original files intact.
- **Live Execution Progress & Service Control**: Real-time WebSocket progress bar showing current executing node title & step count, interrupt button, and Start / Stop / Restart controls for ComfyUI.

### 4. Prompt Snippets & AI Prompt Converter (Gemini / ChatGPT Web)
- **Reusable Snippet Library**: Save and categorize reusable prompt blocks and insert them into any prompt editor with one click.
- **AI Prompt Converter**: Turn any existing asset prompt or a single-sentence idea into structured, model-adapted paragraphs (Krea2, MOSS, Qwen-Image, MiniMax H3, Wan, Flux, etc.) using your own **Gemini** or **ChatGPT** web membership via a persistent local browser profile.
- **Character-Locked Template (`------`) Awareness**: Automatically detects workflows with a `------` divider line, keeps your fixed character trigger block above the divider untouched, and generates only scene/hair/wardrobe/pose/expression/lighting/story paragraphs (excluding facial features, body proportions, and aspect ratio), then pre-fills the workflow creation modal ready to run.

### 5. Bilingual UI, Themes & Windows System Tray Launcher
- **Instant ZH / EN Switching**: One-click language toggle in the top navigation bar and Settings.
- **Dark / Light Theme & 4-Level Global Font Scaling**.
- **Windows Tray Launcher (`launcher/ComfyUILauncher.cs`)**: Single-click tray app with independent submenus to **Open / Start / Restart / Stop** both **ComfyVault (8189)** and **ComfyUI (8188)**.

---

## Quick Start

### Prerequisites
- An existing **ComfyUI** installation (tested with `ComfyUI_windows_portable` and Python 3.11/3.12)
- **Node.js 18+** (only required if rebuilding the frontend)
- **Microsoft Edge** or **Google Chrome** (optional, for the AI Prompt Converter web browser profile)

### 1. Place ComfyVault inside your ComfyUI portable root
```
ComfyUI_windows_portable/
├── ComfyUI/
├── python_embeded/
└── ComfyVault/          <-- clone here
```

### 2. Install Python dependencies
Using ComfyUI's embedded Python:
```powershell
.\python_embeded\python.exe -m pip install aiohttp watchdog pillow pyyaml playwright
```
*(Note: `playwright` is only needed if you use the Gemini/ChatGPT web prompt converter.)*

### 3. Build the Frontend (if `frontend/dist` is not prebuilt)
```powershell
cd ComfyVault\frontend
npm install
npm run build
```

### 4. Launch ComfyVault
```powershell
cd ComfyVault
..\python_embeded\python.exe -s run_vault.py
```
Then open **`http://127.0.0.1:8189/`** in your browser!

### 5. Optional: Compile the Windows Tray Launcher
```powershell
C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe `
  /target:winexe /out:..\ComfyUI启动器.exe `
  /r:System.Windows.Forms.dll /r:System.Drawing.dll `
  launcher\ComfyUILauncher.cs
```

---

## Configuration & Environment Variables

| Variable | Default | Description |
|---|---|---|
| `COMFYVAULT_HOST` | `127.0.0.1` | Host interface for ComfyVault server |
| `COMFYVAULT_PORT` | `8189` | Port for ComfyVault Web UI |
| `COMFYUI_HOST` | `127.0.0.1` | ComfyUI server host |
| `COMFYUI_PORT` | `8188` | ComfyUI server port |

In the Web UI, click the **Settings (gear icon)** in the top bar to configure:
- **Interface Language** (中文 / English), **Theme** (Dark / Light), and **Font Scale**
- **Output / Gallery Directories** (add multiple local image/video folders)
- **Workflow Directories** (add multiple `.json` workflow folders)

---

## Privacy & Security Notes
- Everything runs **100% locally** (`127.0.0.1`).
- Your SQLite index (`data/vault.db`), cached WebP thumbnails (`data/thumbs/`), and optional browser login profile (`data/web_llm_profile/`) stay exclusively inside `ComfyVault/data/` and are ignored by `.gitignore`.

## License
Released under the [MIT License](LICENSE).
