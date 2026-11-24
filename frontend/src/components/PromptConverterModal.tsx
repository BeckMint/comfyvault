import React, { useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  BookmarkPlus,
  CheckCircle2,
  ExternalLink,
  FileCode2,
  Loader2,
  Lock,
  Pin,
  Search,
  Sparkles,
  Wand2,
  X,
} from "lucide-react";
import { api } from "../api";
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
  const [result, setResult] = useState<{
    converted_part: string;
    final_prompt: string;
    has_divider: boolean;
    target_node_id: string;
    target_input_key: string;
    workflow_path: string;
    model_family: string;
  } | null>(null);

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
    } catch (e: any) {
      onToast(e.message || t("打开登录浏览器失败", "Failed to open login browser"), "err");
    }
  };

  const handleConvert = async (autoOpenWorkflow: boolean) => {
    if (!sourceText.trim()) {
      onToast(t("请先输入需要转换的提示词或一句话想法", "Please enter a prompt or a one-line idea to convert first"), "err");
      return;
    }
    if (!selectedWfPath) {
      onToast(t("请先选择一个目标工作流", "Please select a target workflow first"), "err");
      return;
    }
    setConverting(true);
    try {
      const res = await api.convertPromptWithWebLLM({
        source_text: sourceText.trim(),
        provider,
        workflow_path: selectedWfPath,
        target_node_id: activeNode?.node_id,
        target_input_key: activeNode?.input_key,
        model_family: modelFamily || undefined,
        lang_pref: langPref,
        show_window: showWindow,
      });
      setResult(res);
      if (autoOpenWorkflow) {
        onToast(
          t(
            `已通过 ${provider.toUpperCase()} 完成转换并填入工作流！`,
            `Converted with ${provider.toUpperCase()} and filled into workflow!`
          )
        );
        onApplyToWorkflow({
          workflowPath: res.workflow_path,
          nodeId: res.target_node_id,
          inputKey: res.target_input_key,
          text: res.final_prompt,
        });
      } else {
        onToast(t(`已通过 ${provider.toUpperCase()} 完成提示词转换`, `Prompt converted with ${provider.toUpperCase()}`));
      }
    } catch (e: any) {
      onToast(t(`转换失败: ${e.message}`, `Conversion failed: ${e.message}`), "err");
    } finally {
      setConverting(false);
    }
  };

  const handleSaveResultAsSnippet = async () => {
    if (!result) return;
    const defaultTitle = `${result.model_family || t("AI转换", "AI Convert")} - ${sourceText.trim().slice(0, 18)}`;
    try {
      await api.createSnippet({
        title: defaultTitle,
        category: result.has_divider ? t("服装场景", "Outfit & Scene") : t("正向", "Positive"),
        content: result.converted_part,
        notes: t(
          `由 ${provider.toUpperCase()} 转换自：${sourceText.trim().slice(0, 80)}`,
          `Converted by ${provider.toUpperCase()} from: ${sourceText.trim().slice(0, 80)}`
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
                  "把任意资源提示词或一句话想法，按目标工作流模型自动转为段落化结构化提示词，并一键填回工作流创建弹窗",
                  "Convert any asset prompt or one-line idea into a structured paragraph prompt tailored to your target workflow model and apply it with one click"
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

            {/* Source prompt input (auto-fills remaining modal height) */}
            <div className={`flex flex-col gap-1.5 ${result ? "shrink-0" : "flex-1 min-h-[180px]"}`}>
              <label className="text-xs font-semibold text-zinc-200 block shrink-0">
                {t("3. 输入任意原始提示词或一句话想法", "3. Enter any source prompt or one-line idea")}
              </label>
              <textarea
                value={sourceText}
                onChange={(e) => setSourceText(e.target.value)}
                rows={result ? 5 : undefined}
                placeholder={t(
                  "粘贴任意资源提示词，或直接输入一句话（例如：雨夜东京便利店门口，撑着透明雨伞回头看镜头，霓虹灯反射在湿润的地面，电影感胶片色调）...",
                  "Paste any asset prompt or type a short idea (e.g., standing outside a Tokyo convenience store on a rainy night, holding a clear umbrella looking back at the camera, neon reflections on wet pavement, cinematic film look)..."
                )}
                className={`w-full p-3.5 rounded-xl bg-[#0c0f17] border border-zinc-800 text-[13px] text-zinc-100 leading-relaxed focus:outline-none focus:border-indigo-500 ${
                  result ? "resize-y" : "flex-1 min-h-[160px] resize-none"
                }`}
              />
            </div>

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
                {t(
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
              disabled={converting || !sourceText.trim() || !selectedWfPath}
              onClick={() => handleConvert(false)}
              className="px-4 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-zinc-600 disabled:opacity-40 text-xs font-semibold text-zinc-100 flex items-center gap-1.5"
            >
              <Sparkles className="w-3.5 h-3.5 text-amber-400" />
              {t("仅转换预览", "Convert & Preview")}
            </button>
            <button
              type="button"
              disabled={converting || !sourceText.trim() || !selectedWfPath}
              onClick={() => handleConvert(true)}
              className="px-5 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-xs font-semibold text-white flex items-center gap-1.5"
            >
              {converting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Wand2 className="w-3.5 h-3.5" />}
              {converting ? t("转换中...", "Converting...") : t("转换并填入工作流", "Convert & Fill Workflow")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
