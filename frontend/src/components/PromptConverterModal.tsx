import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  BookmarkPlus,
  CheckCircle2,
  ExternalLink,
  Eye,
  FileCode2,
  ImagePlus,
  Loader2,
  Lock,
  Pin,
  RotateCcw,
  Search,
  Sparkles,
  Trash2,
  Upload,
  Wand2,
  X,
} from "lucide-react";
import { api, formatBytes } from "../api";
import { useI18n } from "../i18n";
import type { WorkflowFileItem } from "../types";

export interface WorkflowPrefillPayload {
  workflowPath: string;
  nodeId?: string;
  inputKey?: string;
  text: string;
}

interface PromptNodeInfo {
  node_id: string;
  node_title: string;
  class_type: string;
  input_key: string;
  role: string;
  text: string;
  has_divider: boolean;
  fixed_prefix: string;
  editable_suffix: string;
}

interface Props {
  initialSourceText?: string;
  onClose: () => void;
  onApplyToWorkflow: (prefill: WorkflowPrefillPayload) => void;
  onSavedSnippet?: () => void;
  onToast: (msg: string, tone?: "ok" | "err") => void;
}

const MODEL_FAMILIES = [
  "",
  "Krea2",
  "MOSS",
  "Qwen-Image 2.1",
  "Qwen-Image",
  "MiniMax H3",
  "Wan 2.2",
  "LTX-2.3",
  "Flux.2",
  "Z-Image",
];

export const PromptConverterModal: React.FC<Props> = ({
  initialSourceText = "",
  onClose,
  onApplyToWorkflow,
  onSavedSnippet,
  onToast,
}) => {
  const { t } = useI18n();
  const [sourceText, setSourceText] = useState(initialSourceText);
  const [referenceImage, setReferenceImage] = useState<File | null>(null);
  const [referencePreviewUrl, setReferencePreviewUrl] = useState<string | null>(null);
  const [dragOverImage, setDragOverImage] = useState(false);
  const imageInputRef = useRef<HTMLInputElement | null>(null);

  const attachReferenceFile = (file: File | null) => {
    if (!file) {
      setReferenceImage(null);
      return;
    }
    if (!file.type.startsWith("image/")) {
      onToast(t("请上传图片文件（PNG / JPG / WebP 等）", "Please upload an image file (PNG, JPG, WebP, etc.)"), "err");
      return;
    }
    setReferenceImage(file);
  };

  useEffect(() => {
    if (!referenceImage) {
      setReferencePreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(referenceImage);
    setReferencePreviewUrl(url);
    return () => {
      URL.revokeObjectURL(url);
    };
  }, [referenceImage]);

  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.kind === "file" && item.type.startsWith("image/")) {
          const file = item.getAsFile();
          if (file) {
            e.preventDefault();
            attachReferenceFile(file);
            onToast(t("已粘贴参考图，点击下方按钮即可由大模型反推提示词", "Reference image pasted! Click below to reverse-prompt."));
            break;
          }
        }
      }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, []);
  const [provider, setProvider] = useState<"gemini" | "chatgpt">(() => {
    try {
      const saved = localStorage.getItem("comfyvault_converter_provider");
      return saved === "chatgpt" ? "chatgpt" : "gemini";
    } catch {
      return "gemini";
    }
  });
  const [langPref, setLangPref] = useState<"auto" | "en" | "zh">("auto");
  const [showWindow, setShowWindow] = useState(false);

  const [profileInitialized, setProfileInitialized] = useState(false);
  const [files, setFiles] = useState<WorkflowFileItem[]>([]);
  const [wfSearch, setWfSearch] = useState("");
  const [selectedWfPath, setSelectedWfPath] = useState<string>("");
  const [inspecting, setInspecting] = useState(false);
  const [promptNodes, setPromptNodes] = useState<PromptNodeInfo[]>([]);
  const [selectedNodeKey, setSelectedNodeKey] = useState<string>("");
  const [modelFamily, setModelFamily] = useState<string>("");

  const [converting, setConverting] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [lastAutoOpen, setLastAutoOpen] = useState<boolean>(true);
  const [liveStatus, setLiveStatus] = useState<{
    busy: boolean;
    login_open: boolean;
    stage: string;
    step: number;
    total_steps: number;
    message_zh: string;
    message_en: string;
    started_at: number;
  }>({
    busy: false,
    login_open: false,
    stage: "idle",
    step: 0,
    total_steps: 5,
    message_zh: "",
    message_en: "",
    started_at: 0,
  });
  const [nowSec, setNowSec] = useState<number>(() => Date.now() / 1000);
  const [result, setResult] = useState<{
    converted_part: string;
    final_prompt: string;
    has_divider: boolean;
    target_node_id: string;
    target_input_key: string;
    workflow_path: string;
    model_family: string;
  } | null>(null);

  const pollStatus = () => {
    api
      .getPromptConverterStatus()
      .then((s) => {
        setProfileInitialized(s.profile_initialized);
        setLiveStatus({
          busy: Boolean(s.busy),
          login_open: Boolean(s.login_open),
          stage: s.stage || "idle",
          step: s.step || 0,
          total_steps: s.total_steps || 5,
          message_zh: s.message_zh || "",
          message_en: s.message_en || "",
          started_at: s.started_at || 0,
        });
      })
      .catch(() => {});
  };

  useEffect(() => {
    pollStatus();
    const timer = window.setInterval(() => {
      setNowSec(Date.now() / 1000);
      pollStatus();
    }, converting || liveStatus.busy || liveStatus.login_open ? 1100 : 3500);
    return () => window.clearInterval(timer);
  }, [converting, liveStatus.busy, liveStatus.login_open]);

  const pinnedPaths = useMemo<Set<string>>(() => {
    try {
      const raw = localStorage.getItem("comfyvault_pinned_workflows");
      return new Set(raw ? JSON.parse(raw) : []);
    } catch {
      return new Set();
    }
  }, []);

  useEffect(() => {
    api
      .getPromptConverterStatus()
      .then((s) => setProfileInitialized(s.profile_initialized))
      .catch(() => {});

    api
      .listWorkflowFiles()
      .then((r) => {
        const sorted = [...(r.items || [])].sort((a, b) => {
          const pa = pinnedPaths.has(a.path) ? 1 : 0;
          const pb = pinnedPaths.has(b.path) ? 1 : 0;
          if (pa !== pb) return pb - pa;
          return b.mtime - a.mtime;
        });
        setFiles(sorted);
        if (sorted.length > 0) {
          setSelectedWfPath(sorted[0].path);
        }
      })
      .catch((e) => onToast(t(`加载工作流列表失败: ${e.message}`, `Failed to load workflow list: ${e.message}`), "err"));
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem("comfyvault_converter_provider", provider);
    } catch {
      // ignore
    }
  }, [provider]);

  useEffect(() => {
    if (!selectedWfPath) return;
    let active = true;
    setInspecting(true);
    setResult(null);
    api
      .inspectWorkflowPrompt(selectedWfPath)
      .then((info) => {
        if (!active) return;
        setPromptNodes(info.prompt_nodes || []);
        setModelFamily(info.model_family || "");
        if (info.primary_node) {
          setSelectedNodeKey(`${info.primary_node.node_id}::${info.primary_node.input_key}`);
        } else {
          setSelectedNodeKey("");
        }
      })
      .catch((e) => {
        if (active) onToast(t(`解析工作流主提示词失败: ${e.message}`, `Failed to parse workflow primary prompt: ${e.message}`), "err");
      })
      .finally(() => {
        if (active) setInspecting(false);
      });
    return () => {
      active = false;
    };
  }, [selectedWfPath]);

  const activeNode = useMemo(
    () => promptNodes.find((n) => `${n.node_id}::${n.input_key}` === selectedNodeKey) || null,
    [promptNodes, selectedNodeKey]
  );

  const filteredFiles = useMemo(() => {
    const q = wfSearch.trim().toLowerCase();
    if (!q) return files;
    return files.filter((f) => f.name.toLowerCase().includes(q) || f.folder.toLowerCase().includes(q));
  }, [files, wfSearch]);

  const handleOpenLogin = async (target: "gemini" | "chatgpt") => {
    setErrorMsg(null);
    try {
      const res = await api.openPromptConverterLogin(target);
      onToast(
        res.message ||
          t(
            `已打开 ${target.toUpperCase()} 登录窗口，登录完成后关闭该窗口即可`,
            `Opened ${target.toUpperCase()} login window. Close the window after signing in.`
          )
      );
      setProfileInitialized(true);
      pollStatus();
    } catch (e: any) {
      const msg = e.message || t("打开登录浏览器失败", "Failed to open login browser");
      setErrorMsg(msg);
      onToast(msg, "err");
    }
  };

  const handleResetBrowser = async (retryOpts?: { autoOpen: boolean; forceShowWindow?: boolean }) => {
    setResetting(true);
    try {
      await api.resetPromptConverterBrowser();
      setErrorMsg(null);
      pollStatus();
      if (retryOpts) {
        if (retryOpts.forceShowWindow) setShowWindow(true);
        await handleConvert(retryOpts.autoOpen, retryOpts.forceShowWindow ? true : undefined);
      } else {
        onToast(t("已关闭并重置独立浏览器进程，可以继续操作", "Browser reset. Ready to continue."));
      }
    } catch (e: any) {
      onToast(t(`重置失败: ${e.message}`, `Reset failed: ${e.message}`), "err");
    } finally {
      setResetting(false);
    }
  };

  const handleConvert = async (autoOpenWorkflow: boolean, overrideShowWindow?: boolean) => {
    if (!sourceText.trim() && !referenceImage) {
      onToast(
        t("请先输入提示词/一句话想法，或上传一张参考图进行反推", "Please enter a prompt/idea or upload a reference image first"),
        "err"
      );
      return;
    }
    if (!selectedWfPath) {
      onToast(t("请先选择一个目标工作流", "Please select a target workflow first"), "err");
      return;
    }
    setLastAutoOpen(autoOpenWorkflow);
    setErrorMsg(null);
    setConverting(true);
    const effectiveShowWindow = overrideShowWindow !== undefined ? overrideShowWindow : showWindow;
    try {
      const res = await api.convertPromptWithWebLLM({
        source_text: sourceText.trim(),
        provider,
        workflow_path: selectedWfPath,
        target_node_id: activeNode?.node_id,
        target_input_key: activeNode?.input_key,
        model_family: modelFamily || undefined,
        lang_pref: langPref,
        show_window: effectiveShowWindow,
        image: referenceImage,
      });
      setResult(res);
      setErrorMsg(null);
      if (autoOpenWorkflow) {
        onToast(
          t(
            `已通过 ${provider.toUpperCase()} 完成${referenceImage ? "看图反推" : "转换"}并填入工作流！`,
            `${referenceImage ? "Reverse-prompted" : "Converted"} with ${provider.toUpperCase()} and filled into workflow!`
          )
        );
        onApplyToWorkflow({
          workflowPath: res.workflow_path,
          nodeId: res.target_node_id,
          inputKey: res.target_input_key,
          text: res.final_prompt,
        });
      } else {
        onToast(
          t(
            `已通过 ${provider.toUpperCase()} 完成${referenceImage ? "看图反推" : "提示词转换"}`,
            `${referenceImage ? "Image reverse-prompted" : "Prompt converted"} with ${provider.toUpperCase()}`
          )
        );
      }
    } catch (e: any) {
      const msg = e.message || t("未知错误", "Unknown error");
      setErrorMsg(msg);
      onToast(t(`转换失败: ${msg}`, `Conversion failed: ${msg}`), "err");
    } finally {
      setConverting(false);
      pollStatus();
    }
  };

  const handleSaveResultAsSnippet = async () => {
    if (!result) return;
    const labelSeed = sourceText.trim() || referenceImage?.name || t("图片反推", "Image Reverse");
    const defaultTitle = `${result.model_family || t("AI转换", "AI Convert")} - ${labelSeed.slice(0, 18)}`;
    try {
      await api.createSnippet({
        title: defaultTitle,
        category: result.has_divider ? t("服装场景", "Outfit & Scene") : t("正向", "Positive"),
        content: result.converted_part,
        notes: t(
          `由 ${provider.toUpperCase()} ${referenceImage ? "看图反推" : "转换"}自：${labelSeed.slice(0, 80)}`,
          `${referenceImage ? "Reverse-prompted" : "Converted"} by ${provider.toUpperCase()} from: ${labelSeed.slice(0, 80)}`
        ),
      });
      onSavedSnippet?.();
      onToast(t("已收藏到提示词库", "Saved to Prompt Snippets"));
    } catch (e: any) {
      onToast(t(`收藏失败: ${e.message}`, `Save failed: ${e.message}`), "err");
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-3">
      <div className="w-[95vw] max-w-6xl h-[90vh] bg-[#10141f] border border-zinc-700/90 rounded-2xl shadow-2xl flex flex-col overflow-hidden">
        {/* Header */}
        <div className="px-5 py-3.5 border-b border-zinc-800 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2.5">
            <Wand2 className="w-5 h-5 text-amber-400" />
            <div>
              <h2 className="text-sm font-semibold text-white">
                {t("AI 提示词转换器（Gemini / ChatGPT 网页版会员）", "AI Prompt Converter (Gemini / ChatGPT Web)")}
              </h2>
              <p className="text-[11px] text-zinc-400">
                {t(
                  "输入原始提示词/一句话想法，或上传参考图由大模型反推，按目标工作流模型转为结构化提示词并一键填入",
                  "Enter a prompt/idea or upload a reference image for AI vision reverse-prompting, tailored to your target workflow model"
                )}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-zinc-800 text-zinc-400 hover:text-white"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-12 overflow-hidden">
          {/* Left 4 cols: Workflow Picker */}
          <div className="lg:col-span-4 border-r border-zinc-800 bg-[#0d1018] flex flex-col min-h-0">
            <div className="p-3 border-b border-zinc-800 space-y-2 shrink-0">
              <div className="text-xs font-semibold text-zinc-200 flex items-center justify-between">
                <span>{t("1. 选择目标工作流", "1. Select Target Workflow")}</span>
                <span className="text-[10px] text-zinc-500 font-normal">
                  {t(`共 ${files.length} 个`, `${files.length} total`)}
                </span>
              </div>
              <div className="relative">
                <Search className="w-3.5 h-3.5 text-zinc-500 absolute left-2.5 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={wfSearch}
                  onChange={(e) => setWfSearch(e.target.value)}
                  placeholder={t("搜索工作流名称...", "Search workflow name...")}
                  className="w-full h-8 pl-8 pr-2 rounded-lg bg-[#141824] border border-zinc-800 text-xs text-zinc-100 focus:outline-none focus:border-indigo-500"
                />
              </div>
            </div>
            <div className="flex-1 overflow-y-auto p-2 space-y-1">
              {filteredFiles.map((f) => {
                const active = selectedWfPath === f.path;
                const pinned = pinnedPaths.has(f.path);
                return (
                  <button
                    key={f.path}
                    type="button"
                    onClick={() => setSelectedWfPath(f.path)}
                    className={`w-full text-left p-2.5 rounded-xl border transition-colors ${
                      active
                        ? "bg-indigo-600/20 border-indigo-500/60"
                        : pinned
                        ? "bg-[#151a28] border-amber-500/30 hover:border-amber-400/50"
                        : "bg-[#131722] border-zinc-800/70 hover:border-zinc-700"
                    }`}
                  >
                    <div className="flex items-start gap-2">
                      <FileCode2
                        className={`w-4 h-4 mt-0.5 shrink-0 ${
                          active ? "text-indigo-400" : pinned ? "text-amber-400" : "text-zinc-500"
                        }`}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="text-xs font-medium text-zinc-100 break-words leading-snug">{f.name}</div>
                        <div className="flex items-center gap-2 mt-1 text-[10px] text-zinc-500">
                          {pinned && (
                            <span className="text-amber-300 flex items-center gap-0.5">
                              <Pin className="w-2.5 h-2.5 fill-amber-400" /> {t("置顶", "Pinned")}
                            </span>
                          )}
                          {f.folder && <span className="truncate">{f.folder}</span>}
                        </div>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Right 8 cols: Config + Source Input + Result Preview */}
          <div className="lg:col-span-8 flex flex-col min-h-0 overflow-y-auto p-5 space-y-4">
            {/* Engine + Login bar */}
            <div className="p-3.5 rounded-xl bg-[#141926] border border-zinc-800 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold text-zinc-200">{t("2. 选择网页版 AI：", "2. Select Web AI:")}</span>
                  <button
                    type="button"
                    onClick={() => setProvider("gemini")}
                    className={`px-3 py-1 rounded-lg text-xs font-semibold border transition-colors ${
                      provider === "gemini"
                        ? "bg-indigo-600 border-indigo-400 text-white"
                        : "bg-[#0d1018] border-zinc-700 text-zinc-300 hover:border-zinc-500"
                    }`}
                  >
                    {t("Gemini 网页版", "Gemini Web")}
                  </button>
                  <button
                    type="button"
                    onClick={() => setProvider("chatgpt")}
                    className={`px-3 py-1 rounded-lg text-xs font-semibold border transition-colors ${
                      provider === "chatgpt"
                        ? "bg-emerald-600 border-emerald-400 text-white"
                        : "bg-[#0d1018] border-zinc-700 text-zinc-300 hover:border-zinc-500"
                    }`}
                  >
                    {t("ChatGPT 网页版", "ChatGPT Web")}
                  </button>
                </div>

                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => handleOpenLogin(provider)}
                    className="px-2.5 py-1 rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-[11px] text-amber-300 flex items-center gap-1"
                    title={t(
                      "首次使用请点此打开独立浏览器完成一次手动登录，关闭浏览器后登录态将持久保存在本地缓存",
                      "For first-time use, click to open a standalone browser and sign in manually once. Your login session will be saved locally after closing the browser."
                    )}
                  >
                    <ExternalLink className="w-3 h-3" />
                    {profileInitialized
                      ? t(`检查/重新登录 ${provider.toUpperCase()}`, `Check / Re-login ${provider.toUpperCase()}`)
                      : t(`首次登录 ${provider.toUpperCase()}`, `First-time Login ${provider.toUpperCase()}`)}
                  </button>
                </div>
              </div>

              {/* Workflow Inspection Banner */}
              <div className="flex flex-wrap items-center gap-2.5 pt-2 border-t border-zinc-800/80 text-xs">
                <div className="flex items-center gap-1.5">
                  <span className="text-zinc-400 text-[11px]">{t("目标模型：", "Target Model:")}</span>
                  <select
                    value={modelFamily}
                    onChange={(e) => setModelFamily(e.target.value)}
                    className="h-7 px-2 rounded-md bg-[#0c0f17] border border-zinc-700 text-xs text-zinc-100"
                  >
                    <option value="">{t("自动 / 通用现代模型", "Auto / General Modern Model")}</option>
                    {MODEL_FAMILIES.filter(Boolean).map((mf) => (
                      <option key={mf} value={mf}>
                        {mf}
                      </option>
                    ))}
                    {modelFamily && !MODEL_FAMILIES.includes(modelFamily) && (
                      <option value={modelFamily}>{modelFamily}</option>
                    )}
                  </select>
                </div>

                <div className="flex items-center gap-1.5">
                  <span className="text-zinc-400 text-[11px]">{t("输出语言：", "Output Language:")}</span>
                  <select
                    value={langPref}
                    onChange={(e) => setLangPref(e.target.value as "auto" | "en" | "zh")}
                    className="h-7 px-2 rounded-md bg-[#0c0f17] border border-zinc-700 text-xs text-zinc-100"
                  >
                    <option value="auto">{t("自动适配模型", "Auto-match model")}</option>
                    <option value="en">English</option>
                    <option value="zh">{t("简体中文", "Simplified Chinese")}</option>
                  </select>
                </div>

                {promptNodes.length > 0 && (
                  <div className="flex items-center gap-1.5">
                    <span className="text-zinc-400 text-[11px]">{t("写入节点：", "Target Node:")}</span>
                    <select
                      value={selectedNodeKey}
                      onChange={(e) => setSelectedNodeKey(e.target.value)}
                      className="h-7 px-2 max-w-[240px] rounded-md bg-[#0c0f17] border border-zinc-700 text-xs text-zinc-100"
                    >
                      {promptNodes.map((n) => (
                        <option key={`${n.node_id}::${n.input_key}`} value={`${n.node_id}::${n.input_key}`}>
                          #{n.node_id} {n.node_title} ({n.input_key})
                        </option>
                      ))}
                    </select>
                  </div>
                )}

                <label className="ml-auto flex items-center gap-1.5 text-[11px] text-zinc-400 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={showWindow}
                    onChange={(e) => setShowWindow(e.target.checked)}
                    className="accent-indigo-500"
                  />
                  {t("显示浏览器窗口", "Show browser window")}
                </label>
              </div>

              {/* Divider Detection Status */}
              {inspecting ? (
                <div className="text-[11px] text-zinc-400 flex items-center gap-1.5">
                  <Loader2 className="w-3.5 h-3.5 animate-spin text-indigo-400" />{" "}
                  {t("正在分析工作流主提示词结构...", "Analyzing workflow primary prompt structure...")}
                </div>
              ) : activeNode ? (
                activeNode.has_divider ? (
                  <div className="p-2.5 rounded-lg bg-amber-500/10 border border-amber-500/35 text-[11px] text-amber-200 space-y-1">
                    <div className="font-semibold flex items-center gap-1.5">
                      <Lock className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                      {t("已检测到固定人物模板（含 ------ 分隔线）", "Fixed character template detected (contains ------ divider)")}
                    </div>
                    <div className="text-amber-200/80 leading-relaxed">
                      {t("将自动保留 ", "Automatically preserves ")}
                      <code className="px-1 rounded bg-black/30">------</code>
                      {t(" 及其上方固定人物触发词，仅在下方生成", " and the fixed character trigger block above it, generating below only content ")}
                      <strong>{t("不含人物五官、身材描述、画幅比例", "without facial features, body descriptions, or aspect ratio")}</strong>
                      {t(
                        "的内容，专注保留发型、服装、背景、构图、动作、神态姿势、光影色调与故事表现。",
                        ", focusing on hairstyle, outfit, background, composition, action, expression/pose, lighting/color tone, and storytelling."
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="p-2.5 rounded-lg bg-indigo-500/10 border border-indigo-500/30 text-[11px] text-indigo-200 flex items-center gap-1.5">
                    <CheckCircle2 className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
                    {t("通用工作流模板：将生成完整、适配 ", "General workflow template: generates a complete structured prompt tailored for ")}
                    <strong>{modelFamily || t("目标模型", "the target model")}</strong>
                    {t(" 的段落化结构化提示词并整段填入。", " and fills the entire field.")}
                  </div>
                )
              ) : null}
            </div>

            {/* Source prompt & optional reference image input (auto-fills remaining modal height) */}
            <div
              className={`flex flex-col gap-2 rounded-xl transition-colors ${
                result ? "shrink-0" : "flex-1 min-h-[210px]"
              } ${dragOverImage ? "ring-2 ring-indigo-500/80 bg-indigo-500/5 p-1.5 -m-1.5" : ""}`}
              onDragOver={(e) => {
                e.preventDefault();
                if (!dragOverImage) setDragOverImage(true);
              }}
              onDragLeave={(e) => {
                e.preventDefault();
                setDragOverImage(false);
              }}
              onDrop={(e) => {
                e.preventDefault();
                setDragOverImage(false);
                const dropped = e.dataTransfer.files?.[0];
                if (dropped) attachReferenceFile(dropped);
              }}
            >
              <div className="flex flex-wrap items-center justify-between gap-2 shrink-0">
                <label className="text-xs font-semibold text-zinc-200">
                  {t("3. 输入提示词 或 上传参考图反推", "3. Enter Prompt or Upload Reference Image")}
                </label>
                <div className="flex items-center gap-2">
                  <input
                    ref={imageInputRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0] || null;
                      if (f) attachReferenceFile(f);
                      e.target.value = "";
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => imageInputRef.current?.click()}
                    className="px-2.5 py-1 rounded-lg bg-indigo-500/15 hover:bg-indigo-500/25 border border-indigo-500/40 text-[11px] font-medium text-indigo-200 flex items-center gap-1.5 transition-colors"
                  >
                    <ImagePlus className="w-3.5 h-3.5 text-indigo-300" />
                    {referenceImage
                      ? t("更换参考图", "Change Image")
                      : t("上传参考图（可选）", "Upload Reference Image (Optional)")}
                  </button>
                  <span className="text-[10px] text-zinc-500 hidden sm:inline">
                    {t("支持拖拽 / Ctrl+V 粘贴", "Drag & drop or Ctrl+V")}
                  </span>
                </div>
              </div>

              {/* Reference image preview bar (when attached) */}
              {referenceImage && referencePreviewUrl ? (
                <div className="shrink-0 flex items-center gap-3 p-2.5 rounded-xl bg-[#141926] border border-indigo-500/40">
                  <img
                    src={referencePreviewUrl}
                    alt={referenceImage.name}
                    className="h-16 w-16 rounded-lg object-cover border border-zinc-700 bg-black/40 shrink-0"
                  />
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="px-1.5 py-0.5 rounded bg-indigo-500/20 border border-indigo-400/40 text-[10px] font-semibold text-indigo-200 shrink-0">
                        {t("大模型看图反推模式", "Vision Reverse-Prompt Mode")}
                      </span>
                      <span className="text-xs text-zinc-200 truncate">{referenceImage.name}</span>
                      <span className="text-[10px] text-zinc-500 shrink-0">{formatBytes(referenceImage.size)}</span>
                    </div>
                    <p className="text-[11px] text-zinc-400 leading-snug">
                      {activeNode?.has_divider
                        ? t(
                            "将把此图传给网页版大模型分析反推，自动忽略五官与身材，仅保留发型、服装、姿势、构图、背景与光影并拼接到 ------ 下方。",
                            "Image will be analyzed by the Web LLM while omitting facial features & body proportions, focusing on hair, outfit, pose, framing, setting & lighting below ------."
                          )
                        : t(
                            "将把此图传给网页版大模型深度分析，按目标工作流模型反推为结构化段落提示词。",
                            "Image will be analyzed by the Web LLM and reverse-engineered into a structured prompt for the target model."
                          )}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => attachReferenceFile(null)}
                    className="p-1.5 rounded-lg bg-zinc-800/80 hover:bg-rose-500/20 text-zinc-400 hover:text-rose-300 border border-zinc-700/80 shrink-0"
                    title={t("移除参考图", "Remove image")}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => imageInputRef.current?.click()}
                  className="shrink-0 w-full px-3 py-2 rounded-xl border border-dashed border-zinc-700/90 hover:border-indigo-500/60 bg-[#0d111b] hover:bg-indigo-500/5 text-[11px] text-zinc-400 hover:text-indigo-200 flex items-center justify-center gap-2 transition-colors"
                >
                  <Upload className="w-3.5 h-3.5 text-zinc-500" />
                  <span>
                    {t(
                      "可选：点击上传、拖拽图片到此处，或直接 Ctrl+V 粘贴参考图进行大模型反推",
                      "Optional: Click to upload, drag & drop an image here, or press Ctrl+V to paste a reference image for reverse-prompting"
                    )}
                  </span>
                </button>
              )}

              <textarea
                value={sourceText}
                onChange={(e) => setSourceText(e.target.value)}
                rows={result ? 4 : undefined}
                placeholder={
                  referenceImage
                    ? t(
                        "（可选）补充微调要求，例如：保留构图与光影，把服装换成白色针织衫、背景改为黄昏海边... 留空则直接完整反推参考图",
                        "(Optional) Add tweak instructions, e.g. keep the pose and lighting, change the outfit to a white knit sweater... Leave empty to reverse-prompt the image directly."
                      )
                    : t(
                        "粘贴任意资源提示词，或直接输入一句话（例如：雨夜东京便利店门口，撑着透明雨伞回头看镜头，霓虹灯反射在湿润的地面，电影感胶片色调）...",
                        "Paste any asset prompt or type a short idea (e.g., standing outside a Tokyo convenience store on a rainy night, holding a clear umbrella looking back at the camera, neon reflections on wet pavement, cinematic film look)..."
                      )
                }
                className={`w-full p-3.5 rounded-xl bg-[#0c0f17] border border-zinc-800 text-[13px] text-zinc-100 leading-relaxed focus:outline-none focus:border-indigo-500 ${
                  result ? "resize-y" : "flex-1 min-h-[140px] resize-none"
                }`}
              />
            </div>

            {/* Persistent Login-Window-Open Banner */}
            {liveStatus.login_open && !converting && (
              <div className="shrink-0 p-3 rounded-xl bg-amber-500/12 border border-amber-500/45 flex flex-wrap items-center justify-between gap-2.5 text-xs">
                <div className="flex items-start gap-2 min-w-0 flex-1">
                  <ExternalLink className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                  <div className="space-y-0.5">
                    <div className="font-semibold text-amber-200">
                      {t("独立登录浏览器正在运行", "Standalone login browser is open")}
                    </div>
                    <div className="text-[11px] text-amber-200/80">
                      {t(
                        "请先在弹出的浏览器窗口中完成登录，然后关闭该窗口（或直接点右侧按钮结束并开始反推/转换）。",
                        "Sign in inside the opened browser window, then close it (or click the button on the right once finished)."
                      )}
                    </div>
                  </div>
                </div>
                <button
                  type="button"
                  disabled={resetting}
                  onClick={() => handleResetBrowser()}
                  className="px-3 py-1.5 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 border border-amber-400/50 text-[11px] font-semibold text-amber-100 flex items-center gap-1.5 shrink-0"
                >
                  {resetting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
                  {t("我已登录，关闭登录窗口", "Done Logging In (Close Window)")}
                </button>
              </div>
            )}

            {/* Live Progress Bar Card (while converting or background task busy) */}
            {(converting || (liveStatus.busy && !liveStatus.login_open)) && (
              <div className="shrink-0 p-3.5 rounded-xl bg-indigo-500/10 border border-indigo-500/45 space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2 text-xs font-semibold text-indigo-200">
                    <Loader2 className="w-4 h-4 animate-spin text-indigo-400 shrink-0" />
                    <span>
                      {liveStatus.step > 0 && liveStatus.total_steps > 0
                        ? `[${liveStatus.step}/${liveStatus.total_steps}] `
                        : ""}
                      {t(
                        liveStatus.message_zh ||
                          (referenceImage
                            ? `正在上传参考图并调用 ${provider.toUpperCase()} 网页版反推...`
                            : `正在调用 ${provider.toUpperCase()} 网页版生成提示词...`),
                        liveStatus.message_en ||
                          (referenceImage
                            ? `Uploading image & calling ${provider.toUpperCase()} Web...`
                            : `Calling ${provider.toUpperCase()} Web...`)
                      )}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    {liveStatus.started_at > 0 && (
                      <span className="text-[11px] text-indigo-300/80 font-mono">
                        {t(
                          `已耗时 ${Math.max(0, Math.floor(nowSec - liveStatus.started_at))}s`,
                          `${Math.max(0, Math.floor(nowSec - liveStatus.started_at))}s elapsed`
                        )}
                      </span>
                    )}
                    <button
                      type="button"
                      disabled={resetting}
                      onClick={() => handleResetBrowser()}
                      className="px-2 py-1 rounded-md bg-zinc-800/90 hover:bg-rose-500/20 border border-zinc-700 hover:border-rose-500/40 text-[11px] text-zinc-300 hover:text-rose-200 flex items-center gap-1"
                      title={t("如果长时间无响应，可强制结束后台浏览器进程并重置", "Force-close background browser process if stuck")}
                    >
                      <RotateCcw className="w-3 h-3" />
                      {t("强制重置", "Force Reset")}
                    </button>
                  </div>
                </div>
                <div className="w-full h-1.5 rounded-full bg-zinc-900 overflow-hidden">
                  <div
                    className="h-full bg-gradient-to-r from-indigo-500 via-violet-400 to-indigo-400 transition-all duration-500"
                    style={{
                      width: `${
                        liveStatus.total_steps > 0 && liveStatus.step > 0
                          ? Math.min(96, Math.max(12, Math.round((liveStatus.step / liveStatus.total_steps) * 100)))
                          : 20
                      }%`,
                    }}
                  />
                </div>
              </div>
            )}

            {/* Persistent Inline Error & 1-Click Recovery Card */}
            {errorMsg && !converting && (
              <div className="shrink-0 p-3.5 rounded-xl bg-rose-500/10 border border-rose-500/45 space-y-2.5">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-start gap-2 min-w-0">
                    <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
                    <div className="space-y-0.5 min-w-0">
                      <div className="text-xs font-semibold text-rose-200">
                        {t("执行未完成，请按下方操作处理：", "Action did not complete — try one of the quick fixes below:")}
                      </div>
                      <div className="text-[12px] text-rose-200/90 break-words leading-relaxed">{errorMsg}</div>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setErrorMsg(null)}
                    className="p-1 rounded hover:bg-rose-500/20 text-rose-300/70 hover:text-rose-100 shrink-0"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
                <div className="flex flex-wrap items-center gap-2 pl-6">
                  <button
                    type="button"
                    disabled={resetting}
                    onClick={() => handleResetBrowser({ autoOpen: lastAutoOpen })}
                    className="px-3 py-1 rounded-lg bg-rose-500/20 hover:bg-rose-500/30 border border-rose-400/50 text-[11px] font-semibold text-rose-100 flex items-center gap-1.5"
                  >
                    {resetting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5" />}
                    {t("重置浏览器并立即重试", "Reset Browser & Retry Now")}
                  </button>
                  <button
                    type="button"
                    disabled={resetting}
                    onClick={() => handleResetBrowser({ autoOpen: lastAutoOpen, forceShowWindow: true })}
                    className="px-3 py-1 rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-zinc-600 text-[11px] font-medium text-zinc-100 flex items-center gap-1.5"
                  >
                    <Eye className="w-3.5 h-3.5 text-indigo-300" />
                    {t("显示浏览器窗口重试（便于排查）", "Retry with Visible Browser")}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleOpenLogin(provider)}
                    className="px-3 py-1 rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-[11px] text-amber-300 flex items-center gap-1.5"
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                    {t(`重新登录 ${provider.toUpperCase()}`, `Re-login ${provider.toUpperCase()}`)}
                  </button>
                </div>
              </div>
            )}

            {/* Result preview (if user chose preview mode) */}
            {result && (
              <div className="flex-1 min-h-[180px] flex flex-col p-3.5 rounded-xl bg-[#131826] border border-emerald-500/40 gap-2.5">
                <div className="flex items-center justify-between gap-2 shrink-0">
                  <span className="text-xs font-semibold text-emerald-300 flex items-center gap-1.5">
                    <Sparkles className="w-3.5 h-3.5" />
                    {t("转换结果预览（", "Conversion Result Preview (")}
                    {result.has_divider
                      ? t("已自动拼接在 ------ 下方", "auto-appended below ------")
                      : t("完整提示词", "full prompt")}
                    {t("）", ")")}
                  </span>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={handleSaveResultAsSnippet}
                      className="px-2.5 py-1 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-[11px] text-amber-300 flex items-center gap-1"
                    >
                      <BookmarkPlus className="w-3.5 h-3.5" /> {t("收藏到片段库", "Save as Snippet")}
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        onApplyToWorkflow({
                          workflowPath: result.workflow_path,
                          nodeId: result.target_node_id,
                          inputKey: result.target_input_key,
                          text: result.final_prompt,
                        })
                      }
                      className="px-3 py-1 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-[11px] font-semibold text-white flex items-center gap-1"
                    >
                      {t("填入工作流创建弹窗", "Fill into Workflow Modal")} <ArrowRight className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
                <textarea
                  value={result.final_prompt}
                  onChange={(e) => setResult({ ...result, final_prompt: e.target.value })}
                  className="flex-1 min-h-[120px] w-full p-3 rounded-lg bg-[#0b0e16] border border-zinc-800 text-xs text-zinc-100 leading-relaxed focus:outline-none focus:border-emerald-500 resize-none"
                />
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-zinc-800 bg-[#0d1018] flex flex-wrap items-center justify-between gap-3 shrink-0">
          <div className="text-[11px] text-zinc-400">
            {converting ? (
              <span className="text-amber-300 flex items-center gap-1.5">
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                {referenceImage
                  ? t(
                      `正在上传参考图并调用 ${provider.toUpperCase()} 网页版反推结构化提示词（通常 15~40 秒）...`,
                      `Uploading image & calling ${provider.toUpperCase()} Web to reverse-prompt (usually 15–40s)...`
                    )
                  : t(
                      `正在调用 ${provider.toUpperCase()} 网页版生成结构化提示词（通常 10~30 秒）...`,
                      `Calling ${provider.toUpperCase()} Web to generate structured prompt (usually 10–30s)...`
                    )}
              </span>
            ) : (
              t(
                "提示：首次使用请先点上方「首次登录」在独立浏览器中登录一次，之后即可最小化静默复用缓存",
                "Tip: For first-time use, click 'First-time Login' above to sign in once in the standalone browser; subsequent runs reuse the cached session silently."
              )
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-xs text-zinc-200"
            >
              {t("取消", "Cancel")}
            </button>
            <button
              type="button"
              disabled={converting || (!sourceText.trim() && !referenceImage) || !selectedWfPath}
              onClick={() => handleConvert(false)}
              className="px-4 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-zinc-600 disabled:opacity-40 text-xs font-semibold text-zinc-100 flex items-center gap-1.5"
            >
              <Sparkles className="w-3.5 h-3.5 text-amber-400" />
              {referenceImage ? t("仅反推预览", "Reverse & Preview") : t("仅转换预览", "Convert & Preview")}
            </button>
            <button
              type="button"
              disabled={converting || (!sourceText.trim() && !referenceImage) || !selectedWfPath}
              onClick={() => handleConvert(true)}
              className="px-5 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-xs font-semibold text-white flex items-center gap-1.5"
            >
              {converting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Wand2 className="w-3.5 h-3.5" />}
              {converting
                ? referenceImage
                  ? t("反推中...", "Analyzing...")
                  : t("转换中...", "Converting...")
                : referenceImage
                ? t("反推并填入工作流", "Reverse & Fill Workflow")
                : t("转换并填入工作流", "Convert & Fill Workflow")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
