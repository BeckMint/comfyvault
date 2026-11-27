import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  Copy,
  Film,
  Image as ImageIcon,
  Loader2,
  LogIn,
  RotateCcw,
  Sparkles,
  Wand2,
  X,
} from "lucide-react";
import { api } from "../api";
import { useI18n } from "../i18n";

export interface InlinePromptWriterProps {
  promptJson: Record<string, any> | null;
  workflowName?: string;
  baseModel?: string | null;
  currentText?: string;
  nodeLabel?: string;
  onClose: () => void;
  onInsertText?: (text: string) => void;
  onToast: (msg: string, tone?: "ok" | "err") => void;
}

const MODEL_FAMILY_OPTIONS = [
  "Krea2",
  "Qwen-Image",
  "MOSS",
  "MiniMax H3",
  "Wan 2.2",
  "LTX-2.3",
  "Flux.2",
  "Z-Image",
  "SDXL",
  "通用自然语言",
];

function classifyModelFamily(raw: string): string | null {
  const s = raw.toLowerCase();
  if (!s) return null;
  if (s.includes("krea")) return "Krea2";
  if (s.includes("qwen") && (s.includes("image") || s.includes("edit") || s.includes("2509") || s.includes("2512"))) {
    return "Qwen-Image";
  }
  if (s.includes("moss")) return "MOSS";
  if (s.includes("minimax") || s.includes("hailuo") || /\bh3\b/.test(s)) return "MiniMax H3";
  if (s.includes("wan2") || s.includes("wan_2") || s.includes("wan-2") || s.includes("wanvideo")) return "Wan 2.2";
  if (s.includes("ltx")) return "LTX-2.3";
  if (s.includes("z-image") || s.includes("z_image") || s.includes("zimage")) return "Z-Image";
  if (s.includes("flux")) return "Flux.2";
  if (s.includes("sdxl") || s.includes("pony") || s.includes("illustrious") || s.includes("noob")) return "SDXL";
  if (s.includes("qwen")) return "Qwen-Image";
  return null;
}

export function detectWorkflowContext(
  promptJson: Record<string, any> | null,
  workflowName?: string,
  baseModel?: string | null
): {
  modelFamily: string;
  mediaType: "image" | "video";
  rawModelName: string;
  firstFrameImage: string;
} {
  let mediaType: "image" | "video" = "image";
  let rawModelName = (baseModel || "").trim();
  const candidates: string[] = [];
  const loadImages: Array<{ nid: string; image: string }> = [];

  if (baseModel) candidates.push(baseModel);
  if (workflowName) candidates.push(workflowName);

  if (promptJson && typeof promptJson === "object") {
    for (const nid of Object.keys(promptJson)) {
      const node = promptJson[nid];
      if (!node || typeof node !== "object") continue;
      const ct = String(node.class_type || "");
      const ctl = ct.toLowerCase();
      const inputs = node.inputs || {};

      // Video node detection
      if (
        ctl.includes("savevideo") ||
        ctl.includes("vhs_videocombine") ||
        ctl.includes("createvideo") ||
        ctl.includes("wanvideo") ||
        ctl.includes("ltxv") ||
        ctl.includes("ltx2") ||
        ctl.includes("hunyuanvideo") ||
        ctl.includes("animatediff") ||
        ctl.includes("latentvideo") ||
        (ctl.includes("minimax") && ctl.includes("video"))
      ) {
        mediaType = "video";
      }

      // Model loader detection
      const isModelLoader =
        ctl.includes("unetloader") ||
        ctl.includes("checkpointloader") ||
        ctl.includes("diffusionmodelloader") ||
        ctl.includes("gguf") ||
        ctl.includes("wanvideomodelloader") ||
        ctl.includes("minimax") ||
        ctl.includes("ltx");

      if (isModelLoader && inputs && typeof inputs === "object") {
        for (const k of ["unet_name", "ckpt_name", "model_name", "model", "checkpoint", "diffusion_model"]) {
          const v = inputs[k];
          if (typeof v === "string" && v.trim()) {
            const clean = v.split(/[\\/]/).pop() || v;
            if (!rawModelName) rawModelName = clean;
            candidates.unshift(clean);
          }
        }
      }
      if (ctl.includes("minimax")) candidates.push("MiniMax H3");
      if (ctl.includes("wanvideo")) candidates.push("Wan 2.2");
      if (ctl.includes("ltx")) candidates.push("LTX-2.3");

      // LoadImage first-frame reference detection (for I2V / I2I consistency)
      if (ctl.includes("loadimage") && !ctl.includes("loadimageoutput") && inputs && typeof inputs === "object") {
        const rawImg = inputs.image || inputs.image_path || inputs.widget_0;
        if (typeof rawImg === "string" && rawImg.trim() && rawImg.trim().toLowerCase() !== "image") {
          loadImages.push({ nid, image: rawImg.trim() });
        }
      }
    }
  }

  loadImages.sort((a, b) => a.nid.localeCompare(b.nid, undefined, { numeric: true }));
  const firstFrameImage = loadImages[0]?.image || "";

  let modelFamily = "";
  for (const c of candidates) {
    const cls = classifyModelFamily(c);
    if (cls) {
      modelFamily = cls;
      break;
    }
  }
  if (!modelFamily) {
    modelFamily = rawModelName || "通用自然语言";
  }

  // Secondary video check from detected model family or workflow name
  const checkStr = `${modelFamily} ${workflowName || ""} ${rawModelName}`.toLowerCase();
  if (
    mediaType !== "video" &&
    (checkStr.includes("wan 2") ||
      checkStr.includes("wan2") ||
      checkStr.includes("ltx") ||
      checkStr.includes("视频") ||
      checkStr.includes("t2v") ||
      checkStr.includes("i2v") ||
      checkStr.includes("video"))
  ) {
    mediaType = "video";
  }

  return { modelFamily, mediaType, rawModelName, firstFrameImage };
}

function splitDividerLocal(text: string): { hasDivider: boolean; fixedPrefix: string } {
  if (!text) return { hasDivider: false, fixedPrefix: "" };
  const m = text.match(/^[ \t]*-{4,}[ \t]*$/m);
  if (m && m.index !== undefined) {
    return {
      hasDivider: true,
      fixedPrefix: text.slice(0, m.index + m[0].length).trimEnd(),
    };
  }
  const idx = text.indexOf("------");
  if (idx !== -1) {
    let end = idx;
    while (end < text.length && text[end] === "-") end++;
    return { hasDivider: true, fixedPrefix: text.slice(0, end).trimEnd() };
  }
  return { hasDivider: false, fixedPrefix: "" };
}

function stepToProgress(step: string, elapsed: number): number {
  const s = (step || "").toLowerCase();
  if (s === "done") return 100;
  if (s === "launching") return 14;
  if (s === "navigating") return 28;
  if (s === "loading_model") return Math.min(55, 22 + Math.floor(elapsed * 1.1));
  if (s === "submitting") return 46;
  if (s === "waiting" || s === "generating") {
    return Math.min(92, 50 + Math.floor(elapsed * 1.4));
  }
  return Math.min(88, 18 + Math.floor(elapsed * 2));
}

export const InlinePromptWriterModal: React.FC<InlinePromptWriterProps> = ({
  promptJson,
  workflowName,
  baseModel,
  currentText = "",
  nodeLabel,
  onClose,
  onInsertText,
  onToast,
}) => {
  const { t } = useI18n();

  const detected = useMemo(
    () => detectWorkflowContext(promptJson, workflowName, baseModel),
    [promptJson, workflowName, baseModel]
  );
  const dividerInfo = useMemo(() => splitDividerLocal(currentText), [currentText]);

  const [provider, setProvider] = useState<"gemini" | "chatgpt" | "local_qwenvl">(() => {
    try {
      const saved = localStorage.getItem("comfyvault_converter_provider");
      if (saved === "chatgpt" || saved === "gemini" || saved === "local_qwenvl") return saved;
    } catch {}
    return "gemini";
  });
  const [modelFamily, setModelFamily] = useState<string>(detected.modelFamily);
  const [mediaType, setMediaType] = useState<"image" | "video">(detected.mediaType);
  const [langPref, setLangPref] = useState<"auto" | "en" | "zh">("auto");
  const [useDividerMode, setUseDividerMode] = useState<boolean>(dividerInfo.hasDivider);
  const [attachFirstFrame, setAttachFirstFrame] = useState<boolean>(Boolean(detected.firstFrameImage));
  const [showWindow, setShowWindow] = useState<boolean>(false);

  const draftKey = useMemo(
    () => `${workflowName || "default"}::${nodeLabel || "prompt"}`,
    [workflowName, nodeLabel]
  );

  const loadDraft = (): { idea: string; output: string } => {
    try {
      const raw = localStorage.getItem("comfyvault_inline_writer_drafts_v1");
      const map = raw ? JSON.parse(raw) : {};
      const entry = map && typeof map === "object" ? map[draftKey] : null;
      if (entry && typeof entry === "object") {
        return {
          idea: typeof entry.idea === "string" ? entry.idea : "",
          output: typeof entry.output === "string" ? entry.output : "",
        };
      }
    } catch {}
    return { idea: "", output: "" };
  };

  const saveDraft = (idea: string, output: string) => {
    try {
      const raw = localStorage.getItem("comfyvault_inline_writer_drafts_v1");
      const map = raw ? JSON.parse(raw) : {};
      const nextMap = map && typeof map === "object" ? map : {};
      nextMap[draftKey] = { idea, output, updatedAt: Date.now() };
      const keys = Object.keys(nextMap);
      if (keys.length > 120) {
        for (const k of keys.slice(0, keys.length - 100)) delete nextMap[k];
      }
      localStorage.setItem("comfyvault_inline_writer_drafts_v1", JSON.stringify(nextMap));
    } catch {}
  };

  const initialDraft = useMemo(loadDraft, [draftKey]);
  const [ideaText, setIdeaText] = useState<string>(initialDraft.idea);
  const [outputText, setOutputText] = useState<string>(initialDraft.output);
  const [copied, setCopied] = useState<boolean>(false);

  useEffect(() => {
    saveDraft(ideaText, outputText);
  }, [ideaText, outputText, draftKey]);

  const [generating, setGenerating] = useState<boolean>(false);
  const [openingLogin, setOpeningLogin] = useState<boolean>(false);
  const [resetting, setResetting] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string>("");

  const [progressStep, setProgressStep] = useState<string>("");
  const [progressStepNum, setProgressStepNum] = useState<number>(0);
  const [progressTotalSteps, setProgressTotalSteps] = useState<number>(5);
  const [progressMsg, setProgressMsg] = useState<string>("");
  const [elapsedSec, setElapsedSec] = useState<number>(0);

  const pollTimerRef = useRef<number | null>(null);
  const startTimeRef = useRef<number>(0);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !generating) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [generating, onClose]);

  useEffect(() => {
    return () => {
      if (pollTimerRef.current !== null) {
        window.clearInterval(pollTimerRef.current);
      }
    };
  }, []);

  const stopPolling = () => {
    if (pollTimerRef.current !== null) {
      window.clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  };

  const handleSelectProvider = (p: "gemini" | "chatgpt" | "local_qwenvl") => {
    setProvider(p);
    try {
      localStorage.setItem("comfyvault_converter_provider", p);
    } catch {}
  };

  const handleOpenLogin = async () => {
    if (provider === "local_qwenvl") return;
    setOpeningLogin(true);
    try {
      const res = await api.openPromptConverterLogin(provider);
      onToast(res.message || t("已打开登录窗口，请登录后返回重试", "Login window opened"), "ok");
    } catch (e: any) {
      onToast(e.message || t("打开登录窗口失败", "Failed to open login window"), "err");
    } finally {
      setOpeningLogin(false);
    }
  };

  const handleForceReset = async () => {
    setResetting(true);
    try {
      await api.resetPromptConverterBrowser();
      stopPolling();
      setGenerating(false);
      setProgressStep("");
      setProgressMsg("");
      onToast(t("已强制重置浏览器状态", "Reset browser state"), "ok");
    } catch (e: any) {
      onToast(e.message || t("重置失败", "Reset failed"), "err");
    } finally {
      setResetting(false);
    }
  };

  const handleGenerate = async () => {
    const trimmed = ideaText.trim();
    const hasAttachedFrame = Boolean(attachFirstFrame && detected.firstFrameImage);
    if (!trimmed && !hasAttachedFrame) {
      setErrorMsg(t("请先输入你想要的效果或一句话想法", "Please enter your desired effect or a one-line idea first"));
      return;
    }
    setErrorMsg("");
    setGenerating(true);
    setCopied(false);
    setProgressStep("launching");
    setProgressMsg(
      provider === "local_qwenvl"
        ? t("正在调用本地 Qwen3-VL 生成提示词...", "Calling local Qwen3-VL to generate prompt...")
        : t("正在连接大模型并提交需求...", "Connecting to LLM and submitting request...")
    );
    setElapsedSec(0);
    startTimeRef.current = Date.now();

    stopPolling();
    pollTimerRef.current = window.setInterval(async () => {
      const sec = Math.max(0, Math.floor((Date.now() - startTimeRef.current) / 1000));
      setElapsedSec(sec);
      try {
        const st = await api.getPromptConverterStatus();
        if (st) {
          if (st.stage) setProgressStep(st.stage);
          if (typeof st.step === "number") setProgressStepNum(st.step);
          if (typeof st.total_steps === "number" && st.total_steps > 0) setProgressTotalSteps(st.total_steps);
          const msg = t(st.message_zh || "", st.message_en || "");
          if (msg) setProgressMsg(msg);
        }
      } catch {
        // ignore transient poll errors
      }
    }, 1100);

    try {
      const res = await api.convertPromptWithWebLLM({
        source_text: trimmed,
        provider,
        workflow_path: "",
        model_family: modelFamily === "通用自然语言" ? "" : modelFamily,
        media_type: mediaType,
        has_divider: useDividerMode,
        comfy_input_image: attachFirstFrame && detected.firstFrameImage ? detected.firstFrameImage : undefined,
        lang_pref: langPref,
        show_window: showWindow,
      });
      setOutputText(res.converted_part || res.final_prompt || "");
      setProgressStep("done");
      setProgressMsg(t("生成完成！", "Done!"));
      onToast(t("提示词已生成，可直接复制使用", "Prompt generated and ready to copy"), "ok");
    } catch (e: any) {
      setErrorMsg(e?.message || t("生成失败，请检查模型状态后重试", "Generation failed"));
    } finally {
      stopPolling();
      setGenerating(false);
    }
  };

  const handleCopy = async () => {
    if (!outputText.trim()) return;
    try {
      await navigator.clipboard.writeText(outputText);
      setCopied(true);
      onToast(t("已复制到剪贴板", "Copied to clipboard"), "ok");
      setTimeout(() => setCopied(false), 1800);
    } catch {
      onToast(t("复制失败，请手动全选复制", "Copy failed, please select and copy manually"), "err");
    }
  };

  const handleApplyToBox = (mode: "replace" | "below_divider") => {
    if (!onInsertText || !outputText.trim()) return;
    if (mode === "below_divider" && dividerInfo.hasDivider && dividerInfo.fixedPrefix) {
      onInsertText(dividerInfo.fixedPrefix.trimEnd() + "\n\n" + outputText.trim());
    } else {
      onInsertText(outputText.trim());
    }
    onToast(t("已填入当前提示词框", "Applied to prompt box"), "ok");
    onClose();
  };

  const progressPct = generating
    ? progressStepNum > 0 && progressTotalSteps > 0
      ? Math.min(95, Math.max(stepToProgress(progressStep, elapsedSec), Math.round((progressStepNum / progressTotalSteps) * 90)))
      : stepToProgress(progressStep, elapsedSec)
    : outputText
      ? 100
      : 0;

  return (
    <div
      className="fixed inset-0 z-[75] bg-black/60 flex items-center justify-center p-4"
      onClick={() => {
        if (!generating) onClose();
      }}
    >
      <div
        className="w-full max-w-2xl max-h-[90vh] rounded-2xl bg-[#111521] border border-zinc-700/80 shadow-2xl flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-5 py-3.5 bg-[#161b2a] border-b border-zinc-800 flex items-center justify-between gap-3 shrink-0">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-indigo-500/30 to-fuchsia-500/30 border border-indigo-400/40 flex items-center justify-center shrink-0">
              <Wand2 className="w-4 h-4 text-indigo-300" />
            </div>
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-zinc-100 flex items-center gap-2">
                {t("AI 写提示词", "AI Prompt Writer")}
                {nodeLabel && (
                  <span className="text-[11px] font-mono font-normal text-indigo-300/90 bg-indigo-500/15 border border-indigo-500/30 px-2 py-0.5 rounded-md truncate max-w-[260px]">
                    {nodeLabel}
                  </span>
                )}
              </h3>
              <p className="text-[11px] text-zinc-400 truncate">
                {t(
                  "自动识别当前工作流底模与图片/视频类型，调用大模型生成专业提示词",
                  "Auto-detects workflow base model & image/video type to craft tailored prompts"
                )}
              </p>
            </div>
          </div>
          <button
            type="button"
            disabled={generating}
            onClick={onClose}
            className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 disabled:opacity-40"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {/* Row 1: Auto-detected workflow context (Base Model + Image/Video + Language) */}
          <div className="p-3.5 rounded-xl bg-[#0d111b] border border-zinc-800/90 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-[11px] font-semibold text-zinc-300 flex items-center gap-1.5">
                <Sparkles className="w-3.5 h-3.5 text-amber-400" />
                {t("已自动识别当前工作流上下文", "Auto-detected Workflow Context")}
              </span>
              {detected.rawModelName && (
                <span
                  className="text-[10px] font-mono text-zinc-400 bg-zinc-800/80 px-2 py-0.5 rounded truncate max-w-[280px]"
                  title={detected.rawModelName}
                >
                  {t("底模文件", "Checkpoint")}: {detected.rawModelName}
                </span>
              )}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
              {/* Base model selector */}
              <div className="space-y-1">
                <label className="text-[11px] text-zinc-400 block">{t("目标底模", "Target Base Model")}</label>
                <select
                  value={MODEL_FAMILY_OPTIONS.includes(modelFamily) ? modelFamily : "custom"}
                  onChange={(e) => {
                    if (e.target.value !== "custom") setModelFamily(e.target.value);
                  }}
                  disabled={generating}
                  className="w-full h-8 px-2.5 rounded-lg bg-[#151a28] border border-zinc-700 text-xs text-zinc-100 focus:outline-none focus:border-indigo-500"
                >
                  {!MODEL_FAMILY_OPTIONS.includes(modelFamily) && (
                    <option value="custom">{modelFamily}</option>
                  )}
                  {MODEL_FAMILY_OPTIONS.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </div>

              {/* Media type toggle: Image vs Video */}
              <div className="space-y-1">
                <label className="text-[11px] text-zinc-400 block">{t("生成类型", "Media Type")}</label>
                <div className="grid grid-cols-2 gap-1 p-0.5 rounded-lg bg-[#151a28] border border-zinc-700 h-8">
                  <button
                    type="button"
                    disabled={generating}
                    onClick={() => setMediaType("image")}
                    className={`rounded-md text-xs font-medium flex items-center justify-center gap-1 transition-colors ${
                      mediaType === "image"
                        ? "bg-indigo-600 text-white shadow"
                        : "text-zinc-400 hover:text-zinc-200"
                    }`}
                  >
                    <ImageIcon className="w-3.5 h-3.5" />
                    {t("图片", "Image")}
                  </button>
                  <button
                    type="button"
                    disabled={generating}
                    onClick={() => setMediaType("video")}
                    className={`rounded-md text-xs font-medium flex items-center justify-center gap-1 transition-colors ${
                      mediaType === "video"
                        ? "bg-fuchsia-600 text-white shadow"
                        : "text-zinc-400 hover:text-zinc-200"
                    }`}
                  >
                    <Film className="w-3.5 h-3.5" />
                    {t("视频", "Video")}
                  </button>
                </div>
              </div>

              {/* Output language */}
              <div className="space-y-1">
                <label className="text-[11px] text-zinc-400 block">{t("输出语言", "Output Language")}</label>
                <select
                  value={langPref}
                  onChange={(e) => setLangPref(e.target.value as "auto" | "en" | "zh")}
                  disabled={generating}
                  className="w-full h-8 px-2.5 rounded-lg bg-[#151a28] border border-zinc-700 text-xs text-zinc-100 focus:outline-none focus:border-indigo-500"
                >
                  <option value="auto">{t("自动适配底模", "Auto for Model")}</option>
                  <option value="en">English</option>
                  <option value="zh">简体中文</option>
                </select>
              </div>
            </div>

            {detected.firstFrameImage && (
              <div className="pt-2 border-t border-zinc-800/80 flex items-center gap-3">
                <img
                  src={`/api/comfy/input-image?name=${encodeURIComponent(detected.firstFrameImage)}`}
                  alt={detected.firstFrameImage}
                  className="w-12 h-12 rounded-lg object-cover border border-indigo-500/40 bg-black shrink-0"
                />
                <label className="flex items-start gap-2 text-[11px] text-indigo-200 cursor-pointer select-none flex-1 min-w-0">
                  <input
                    type="checkbox"
                    checked={attachFirstFrame}
                    disabled={generating}
                    onChange={(e) => setAttachFirstFrame(e.target.checked)}
                    className="accent-indigo-500 mt-0.5 shrink-0"
                  />
                  <span className="leading-snug">
                    {mediaType === "video"
                      ? t(
                          `自动附带工作流首帧参考图（${detected.firstFrameImage}）给大模型看图写词：严格锁定首帧人物、服装、道具与场景，禁止切镜换人`,
                          `Attach workflow first-frame (${detected.firstFrameImage}) so AI locks subject, outfit, props & scene with zero hard cuts`
                        )
                      : t(
                          `自动附带工作流输入参考图（${detected.firstFrameImage}）给大模型看图写词`,
                          `Attach workflow input image (${detected.firstFrameImage}) for vision-guided prompt writing`
                        )}
                  </span>
                </label>
              </div>
            )}

            {dividerInfo.hasDivider && (
              <label className="flex items-center gap-2 pt-1 text-[11px] text-amber-300/90 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={useDividerMode}
                  disabled={generating}
                  onChange={(e) => setUseDividerMode(e.target.checked)}
                  className="accent-amber-500"
                />
                <span>
                  {t(
                    "检测到当前框包含 ------ 角色锁定分隔线：仅生成场景/动作/构图/光影，不重复写固定脸型身材",
                    "Detected ------ character-lock divider: generate scene/pose/lighting only without duplicating face/body"
                  )}
                </span>
              </label>
            )}
          </div>

          {/* Row 2: Select LLM Engine (3 existing models) */}
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <label className="text-xs font-medium text-zinc-200">
                {t("选择大模型", "Select AI Model")}
              </label>
              {provider !== "local_qwenvl" && (
                <div className="flex items-center gap-2">
                  <label className="flex items-center gap-1.5 text-[11px] text-zinc-400 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={showWindow}
                      disabled={generating}
                      onChange={(e) => setShowWindow(e.target.checked)}
                      className="accent-indigo-500"
                    />
                    {t("显示浏览器窗口", "Show Browser")}
                  </label>
                  <button
                    type="button"
                    disabled={openingLogin || generating}
                    onClick={handleOpenLogin}
                    className="h-6 px-2 rounded-md bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-[11px] text-zinc-300 flex items-center gap-1 disabled:opacity-50"
                  >
                    <LogIn className="w-3 h-3" />
                    {t("检查/登录", "Login")}
                  </button>
                </div>
              )}
            </div>

            <div className="grid grid-cols-3 gap-2">
              {[
                {
                  id: "gemini" as const,
                  title: "Gemini 网页版",
                  sub: t("文采细腻 · 约15-25s", "Rich prose · ~15-25s"),
                },
                {
                  id: "chatgpt" as const,
                  title: "ChatGPT 网页版",
                  sub: t("结构稳定 · 约15-25s", "Structured · ~15-25s"),
                },
                {
                  id: "local_qwenvl" as const,
                  title: "本地 Qwen3-VL",
                  sub: t("离线无审核 · 约20-40s", "Local uncensored"),
                },
              ].map((opt) => {
                const active = provider === opt.id;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    disabled={generating}
                    onClick={() => handleSelectProvider(opt.id)}
                    className={`p-2.5 rounded-xl border text-left transition-all ${
                      active
                        ? "bg-indigo-600/20 border-indigo-500 text-indigo-100 shadow-sm"
                        : "bg-[#0d111b] border-zinc-800 text-zinc-300 hover:border-zinc-700"
                    }`}
                  >
                    <div className="text-xs font-semibold truncate">{opt.title}</div>
                    <div className="text-[10px] text-zinc-400 truncate mt-0.5">{opt.sub}</div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Row 3: User idea input */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <label className="text-xs font-medium text-zinc-200">
                {t("输入你想要的效果或一句话想法", "Describe the desired effect or a one-line idea")}
              </label>
              <div className="flex items-center gap-2">
                {ideaText.trim() && (
                  <button
                    type="button"
                    disabled={generating}
                    onClick={() => setIdeaText("")}
                    className="text-[10px] text-zinc-400 hover:text-rose-300 disabled:opacity-40"
                  >
                    {t("清空", "Clear")}
                  </button>
                )}
                <span className="text-[10px] text-zinc-500">Ctrl + Enter {t("提交", "to generate")}</span>
              </div>
            </div>
            <textarea
              value={ideaText}
              disabled={generating}
              onChange={(e) => setIdeaText(e.target.value)}
              onKeyDown={(e) => {
                if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && !generating) {
                  e.preventDefault();
                  handleGenerate();
                }
              }}
              rows={3}
              placeholder={
                mediaType === "video"
                  ? t(
                      "例如：黄昏海边长镜头缓慢推进，女孩回眸微笑，长发被海风吹起，胶片暖色调...",
                      "e.g. Slow push-in shot at sunset beach, girl turns back smiling as sea breeze lifts her hair, warm film look..."
                    )
                  : t(
                      "例如：深夜便利店门口，雨后霓虹倒影，低角度仰拍全身，穿黑色风衣打透明伞，王家卫胶片氛围...",
                      "e.g. Late-night convenience store entrance, wet neon reflections, low-angle full body, black trench coat & clear umbrella..."
                    )
              }
              className="w-full p-3 rounded-xl bg-[#0b0e16] border border-zinc-700 focus:border-indigo-500 focus:outline-none text-[13px] text-zinc-100 leading-relaxed resize-y"
            />
          </div>

          {/* Submit button + Live Progress Bar */}
          <div className="space-y-2.5">
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={generating || (!ideaText.trim() && !(attachFirstFrame && detected.firstFrameImage))}
                onClick={handleGenerate}
                className="flex-1 h-10 rounded-xl bg-gradient-to-r from-indigo-600 to-fuchsia-600 hover:from-indigo-500 hover:to-fuchsia-500 disabled:opacity-50 text-white text-xs font-semibold flex items-center justify-center gap-2 shadow-lg shadow-indigo-900/30 transition-all"
              >
                {generating ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    {t("正在生成提示词...", "Generating prompt...")} ({elapsedSec}s)
                  </>
                ) : (
                  <>
                    <Sparkles className="w-4 h-4" />
                    {t("提交生成提示词", "Generate Prompt")}
                  </>
                )}
              </button>

              {generating && provider !== "local_qwenvl" && (
                <button
                  type="button"
                  disabled={resetting}
                  onClick={handleForceReset}
                  title={t("如果浏览器卡住，点此强制重置", "Force reset if browser gets stuck")}
                  className="h-10 px-3 rounded-xl bg-zinc-800 hover:bg-rose-900/50 border border-zinc-700 hover:border-rose-500/50 text-zinc-300 hover:text-rose-200 text-xs flex items-center gap-1.5 shrink-0"
                >
                  <RotateCcw className={`w-3.5 h-3.5 ${resetting ? "animate-spin" : ""}`} />
                  {t("强制重置", "Reset")}
                </button>
              )}
            </div>

            {/* Live Progress Bar */}
            {(generating || progressPct > 0) && (
              <div className="p-3 rounded-xl bg-[#0d111b] border border-zinc-800 space-y-1.5">
                <div className="flex items-center justify-between text-[11px]">
                  <span className={generating ? "text-indigo-300" : "text-emerald-400"}>
                    {progressMsg || (generating ? t("处理中...", "Working...") : t("已完成", "Completed"))}
                  </span>
                  <span className="font-mono text-zinc-400">
                    {progressPct}% {generating ? `· ${elapsedSec}s` : ""}
                  </span>
                </div>
                <div className="w-full h-2 rounded-full bg-zinc-800 overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all duration-500 ${
                      generating
                        ? "bg-gradient-to-r from-indigo-500 via-fuchsia-500 to-indigo-400 animate-pulse"
                        : "bg-emerald-500"
                    }`}
                    style={{ width: `${progressPct}%` }}
                  />
                </div>
              </div>
            )}

            {/* Inline Error Box */}
            {errorMsg && (
              <div className="p-3 rounded-xl bg-rose-950/40 border border-rose-500/40 flex items-start gap-2.5 text-xs text-rose-200">
                <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0 break-words">{errorMsg}</div>
              </div>
            )}
          </div>

          {/* Row 4: Separate Output Box for Copying */}
          <div className="space-y-1.5 pt-1 border-t border-zinc-800/80">
            <div className="flex items-center justify-between gap-2">
              <label className="text-xs font-medium text-zinc-200">
                {t("生成结果（供复制使用）", "Generated Prompt (Ready to Copy)")}
              </label>
              <div className="flex items-center gap-1.5">
                {onInsertText && outputText.trim() && (
                  <>
                    {dividerInfo.hasDivider ? (
                      <button
                        type="button"
                        onClick={() => handleApplyToBox("below_divider")}
                        className="h-7 px-2.5 rounded-lg bg-emerald-600/20 hover:bg-emerald-600/35 border border-emerald-500/40 text-emerald-200 text-[11px] font-medium"
                      >
                        {t("填入 ------ 下方", "Insert Below ------")}
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => handleApplyToBox("replace")}
                        className="h-7 px-2.5 rounded-lg bg-emerald-600/20 hover:bg-emerald-600/35 border border-emerald-500/40 text-emerald-200 text-[11px] font-medium"
                      >
                        {t("直接填入此框", "Apply to Box")}
                      </button>
                    )}
                  </>
                )}
                <button
                  type="button"
                  disabled={!outputText.trim()}
                  onClick={handleCopy}
                  className="h-7 px-3 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white text-[11px] font-medium flex items-center gap-1.5 transition-colors"
                >
                  {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                  {copied ? t("已复制", "Copied") : t("一键复制", "Copy")}
                </button>
              </div>
            </div>
            <textarea
              value={outputText}
              onChange={(e) => setOutputText(e.target.value)}
              rows={6}
              placeholder={t(
                "生成后的完整专业提示词将显示在这里，你可以点击右上角「一键复制」或手动编辑...",
                "Your generated prompt will appear here. Click Copy or edit directly..."
              )}
              className="w-full p-3 rounded-xl bg-[#090c13] border border-zinc-800 focus:border-indigo-500 focus:outline-none text-[13px] text-zinc-100 leading-relaxed resize-y"
            />
          </div>
        </div>
      </div>
    </div>
  );
};
