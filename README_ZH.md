<div align="center">

# ComfyVault `v0.1.15`

**面向 ComfyUI 的本地资产管理器、参数版本追踪器、工作流直连启动台与无损微调工作室**

![Version](https://img.shields.io/badge/version-0.1.15-indigo) ![License](https://img.shields.io/badge/license-MIT-emerald)

[English](README.md) · [简体中文](README_ZH.md)

<br/>

![ComfyVault 界面截图](docs/screenshot.jpg)

</div>

---

## ComfyVault 是什么？

**ComfyVault** 是一个运行在本地（`http://127.0.0.1:8189`）的 ComfyUI 伴侣工作台。它可以把你的 `ComfyUI/output` 目录（以及任意多个外部相册/归档目录）变成一个 60fps 流畅浏览、可检索全部提示词与参数的可视化资产库，并集成了 **工作流节点可视化编辑与直连生成、无损微调派生、LoRA 权重档案、A/B 对比 Diff、以及基于 Gemini/ChatGPT 网页版的 AI 提示词转换器**。

## 核心功能

### 1. 高性能多目录资产相册
- **多相册 / Output 目录支持**：默认监听 `ComfyUI/output`，并可在设置页添加多个本地相册或历史归档目录；支持增量快速扫描、`watchdog` 实时监听新图、以及自动跳过 NTFS 目录联接避免重复索引。
- **60fps 虚拟滚动瀑布流**：轻松承载上万张 PNG/WebP/JPG 图片与 MP4/WebM 视频，支持后台低并发 WebP 缩略图预热、视频悬停预览、框选多选、批量打标/评分/移入系统回收站。
- **WebGL2 硬件加速看图器**：暗房级平滑缩放（最高 400% 锚点锁定缩放）、双击 100%/自适应切换、左键拖拽平移。
- **多维度精准筛选**：支持按物理文件夹树（含右键资源管理器打开/重命名/移入回收站）、基础模型族（Krea2、Qwen-Image、MOSS、MiniMax H3、Flux.2、Wan 2.2、LTX-2.3 等）、LoRA、底模、工作流指纹、ComfyUI Git 版本、星级、精选/废片与自定义标签筛选。
- **按配方折叠 & A/B 视觉对比**：将相同提示词与参数、仅 Seed 不同的抽卡结果折叠展示；任意勾选两张图即可进行分屏滑块对比及提示词/LoRA/参数 Diff。

### 2. 工作流创建弹窗 & 完整节点可视化编辑
- **多工作流目录扫描与置顶**：在设置页配置多个 `.json` 工作流目录（兼容 UI 与 API 格式），支持增量缓存、工作流置顶、以及每个工作流内部**常用节点独立置顶**。
- **完整可编辑节点表单**：按 `#节点编号` 排序，支持 `LoadImage` 缩略图预览与直接上传图片到 ComfyUI，内置 **Power LoRA 编辑器**（增删、排序、开关、权重微调、并自动从 `.civitai.info` / `.metadata.json` / `.rgthree-info.json` 与历史记录识别每张 LoRA 的推荐上下限）。
- **原地保存修改**：点击保存即可将修改后的提示词、LoRA 与参数直接写回工作流文件，无需退出弹窗。

### 3. 无损微调派生 & ComfyUI 实时桥接
- **一键重摇（Reroll）与无损微调（Remix）**：对任意已生成的资产直接微调提示词、LoRA 或节点参数并提交 ComfyUI 生成新图，同时支持覆盖保存当前微调参数。
- **实时生成进度与服务控制**：通过 WebSocket 实时显示当前执行节点名称与步数进度条，支持一键中断生成，以及在网页顶部直接启动/重启/停止 ComfyUI。

### 4. 提示词片段库 & AI 提示词转换器（Gemini / ChatGPT 网页版）
- **常用片段库**：分类沉淀常用外貌、光影、服装、运镜、负向模板，编辑提示词时一键插入。
- **AI 提示词转换器**：把任意已有资源的提示词或一句中文想法，调用你自己的 **Gemini** 或 **ChatGPT** 网页版会员（基于本地独立 Edge 缓存目录，首次手动登录一次即可复用登录态最小化静默调用），按目标工作流模型自动转换为段落化结构化提示词。
- **固定人物模板（`------`）智能识别**：自动识别主提示词框中的 `------` 分隔线，保留上方固定人物触发词不变，仅在下方生成**不含五官、身材描述、画幅比例**的发型、服装、背景、构图、动作、神态姿势、光影色调与故事表现段落，并一键填进工作流创建弹窗直接检阅生成。

### 5. 中英文切换、主题缩放 & Windows 系统托盘启动器
- **界面中英文一键切换**：顶部导航栏与设置页均可随时切换简体中文 / English。
- **深色暗房 / 浅色模式 & 4 档全局字号缩放**。
- **系统托盘启动器（`launcher/ComfyUILauncher.cs`）**：右键菜单提供 **ComfyVault (8189)** 与 **ComfyUI (8188)** 各自独立的「打开网页 / 启动 / 重启 / 停止」控制以及一键启停全部。

---

## 快速开始

### 环境要求
- 已安装 **ComfyUI**（推荐 `ComfyUI_windows_portable`，Python 3.11/3.12）
- **Node.js 18+**（仅自行修改并重新构建前端时需要）
- **Microsoft Edge** 或 **Google Chrome**（可选，仅使用 AI 提示词转换器时需要）

### 1. 放置目录结构
将本仓库放到 `ComfyUI_windows_portable` 根目录下：
```
ComfyUI_windows_portable/
├── ComfyUI/
├── python_embeded/
└── ComfyVault/          <-- 克隆到此目录
```

### 2. 安装 Python 依赖
使用 ComfyUI 自带的嵌入式 Python：
```powershell
.\python_embeded\python.exe -m pip install aiohttp watchdog pillow pyyaml playwright
```
> 注：如果不使用 Gemini / ChatGPT 网页版提示词转换功能，可以不安装 `playwright`。

### 3. 构建前端（如未包含预构建 `frontend/dist`）
```powershell
cd ComfyVault\frontend
npm install
npm run build
```

### 4. 启动 ComfyVault
```powershell
cd ComfyVault
..\python_embeded\python.exe -s run_vault.py
```
启动后在浏览器访问 **`http://127.0.0.1:8189/`** 即可使用。

### 5. 可选：编译 Windows 系统托盘启动器
```powershell
C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe `
  /target:winexe /out:..\ComfyUI启动器.exe `
  /r:System.Windows.Forms.dll /r:System.Drawing.dll `
  launcher\ComfyUILauncher.cs
```

---

## 配置与环境变量

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `COMFYVAULT_HOST` | `127.0.0.1` | ComfyVault 监听地址 |
| `COMFYVAULT_PORT` | `8189` | ComfyVault 端口 |
| `COMFYUI_HOST` | `127.0.0.1` | ComfyUI 地址 |
| `COMFYUI_PORT` | `8188` | ComfyUI 端口 |

在网页右上角点击 **设置（齿轮图标）** 即可可视化配置：
- 界面语言（简体中文 / English）、深浅色主题、全局文字缩放；
- 多个 **相册 / Output 扫描目录**；
- 多个 **工作流 `.json` 扫描目录**。

---

## 隐私与安全说明
- 所有数据与服务均 **100% 运行在本地**（`127.0.0.1`）。
- 本地数据库（`data/vault.db`）、缩略图缓存（`data/thumbs/`）与浏览器登录态缓存（`data/web_llm_profile/`）均存放在 `ComfyVault/data/` 下，并已通过 `.gitignore` 排除，上传 GitHub 时不会被提交。

## 开源协议
本项目基于 [MIT License](LICENSE) 开源。
