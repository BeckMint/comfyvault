import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  BookmarkPlus,
  Check,
  Columns2,
  Copy,
  Download,
  FolderSearch,
  GitBranch,
  Layers,
  Play,
  Plus,
  SlidersHorizontal,
  Star,
  ThumbsDown,
  ThumbsUp,
  Trash2,
  X,
} from "lucide-react";
import { api, formatBytes, formatTime } from "../api";
import { useI18n } from "../i18n";
import type { AssetDetail, ComfyStatus, PromptNodeEntry } from "../types";
import { RefCompareModal } from "./RefCompareModal";

interface Props {
  assetId: number;
  refreshTick?: number;
  comfyStatus: ComfyStatus;
  onClose: () => void;
  onSelectAssetId: (id: number) => void;
  onOpenRemix: (detail: AssetDetail) => void;
  onFilterRecipe: (recipeHash: string) => void;
  onFilterLora: (loraName: string) => void;
  onMutated: () => void;
  onToast: (msg: string, tone?: "ok" | "err") => void;
}

const ROLE_STYLES: Record<string, { zh: string; en: string; cls: string }> = {
  positive: { zh: "正向", en: "Positive", cls: "bg-emerald-500/20 text-emerald-300 border-emerald-500/30" },
  negative: { zh: "负向", en: "Negative", cls: "bg-rose-500/20 text-rose-300 border-rose-500/30" },
  upscale: { zh: "精修/放大", en: "Upscale/Refine", cls: "bg-amber-500/20 text-amber-300 border-amber-500/30" },
  system: { zh: "系统", en: "System", cls: "bg-sky-500/20 text-sky-300 border-sky-500/30" },
  prompt: { zh: "提示词", en: "Prompt", cls: "bg-indigo-500/20 text-indigo-300 border-indigo-500/30" },
};

function compareNodeId(a: string, b: string): number {
  const pa = a.split(":").map((s) => Number(s));
  const pb = b.split(":").map((s) => Number(s));
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const va = pa[i] ?? -1;
    const vb = pb[i] ?? -1;
    if (!Number.isNaN(va) && !Number.isNaN(vb) && va !== vb) {
      return va - vb;
    }
  }
  return a.localeCompare(b, undefined, { numeric: true });
}

export const AssetDetailDrawer: React.FC<Props> = ({
  assetId,
  refreshTick = 0,
  comfyStatus,
  onClose,
  onSelectAssetId,
  onOpenRemix,
  onFilterRecipe,
  onFilterLora,
  onMutated,
  onToast,
}) => {
  const { t } = useI18n();
  const [detail, setDetail] = useState<AssetDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [notes, setNotes] = useState("");
  const [recipeNote, setRecipeNote] = useState("");
  const [newTag, setNewTag] = useState("");
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [rerollBatch, setRerollBatch] = useState(1);
  const [rerolling, setRerolling] = useState(false);
  const [lightbox, setLightbox] = useState(false);
  const [showRefCompare, setShowRefCompare] = useState(false);
  const drawerVideoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    const pauseDrawer = () => {
      drawerVideoRef.current?.pause();
    };
    window.addEventListener("comfyvault:pause-bg-videos", pauseDrawer);
    window.addEventListener("comfyvault:pause-drawer-video", pauseDrawer);
    return () => {
      window.removeEventListener("comfyvault:pause-bg-videos", pauseDrawer);
      window.removeEventListener("comfyvault:pause-drawer-video", pauseDrawer);
    };
  }, []);

  useEffect(() => {
    if (!lightbox) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setLightbox(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lightbox]);

  const sortedPrompts = useMemo(() => {
    if (!detail?.prompts) return [];
    return [...detail.prompts].sort((a, b) => compareNodeId(a.node_id, b.node_id));
  }, [detail?.prompts]);

  useEffect(() => {
    let active = true;
    if (refreshTick === 0) setLoading(true);
    api
      .getAssetDetail(assetId)
      .then((d) => {
        if (!active) return;
        setDetail(d);
        setNotes(d.notes || "");
        setRecipeNote(d.recipe_note?.notes || "");
      })
      .catch((e) => onToast(t(`加载详情失败: ${e.message}`, `Failed to load details: ${e.message}`), "err"))
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [assetId, refreshTick]);

  const copyText = async (text: string, key: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(null), 1500);
      onToast(t("已复制到剪贴板", "Copied to clipboard"));
    } catch {
      onToast(t("复制失败", "Copy failed"), "err");
    }
  };

  const saveAssetPatch = async (patch: { rating?: number; flag?: string; notes?: string; is_deleted?: boolean }) => {
    if (!detail) return;
    try {
      const updated = await api.patchAsset(detail.id, patch);
      setDetail(updated);
      onMutated();
    } catch (e: any) {
      onToast(e.message, "err");
    }
  };

  const handleAddTag = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!detail || !newTag.trim()) return;
    try {
      await api.attachTag(detail.id, { name: newTag.trim() });
      setNewTag("");
      const updated = await api.getAssetDetail(detail.id);
      setDetail(updated);
      onMutated();
    } catch (err: any) {
      onToast(err.message, "err");
    }
  };

  const handleRemoveTag = async (tagId: number) => {
    if (!detail) return;
    await api.detachTag(detail.id, tagId);
    const updated = await api.getAssetDetail(detail.id);
    setDetail(updated);
    onMutated();
  };

  const handleSaveRecipeNote = async () => {
    if (!detail?.recipe_hash) return;
    await api.saveRecipeNote(detail.recipe_hash, "", recipeNote);
    onToast(t("配方笔记已保存", "Recipe note saved"));
  };

  const handleReroll = async () => {
    if (!detail) return;
    setRerolling(true);
    try {
      const res = await api.rerollAsset(detail.id, rerollBatch);
      onToast(t(`已提交 ${res.prompt_ids.length} 个再生成任务到 ComfyUI 队列`, `Queued ${res.prompt_ids.length} reroll task(s) in ComfyUI`));
    } catch (e: any) {
      onToast(t(`再生成失败: ${e.message}`, `Reroll failed: ${e.message}`), "err");
    } finally {
      setRerolling(false);
    }
  };

  const handleSaveSnippet = async (p: PromptNodeEntry) => {
    try {
      await api.createSnippet({
        title: `${detail?.filename || t("提示词", "Prompt")} · ${p.node_title}`,
        category: p.role === "negative" ? "负向" : p.role === "upscale" ? "精修" : "正向",
        content: p.text,
      });
      onToast(t("已收藏到提示词片段库", "Saved to Prompt Snippets"));
    } catch (e: any) {
      onToast(e.message, "err");
    }
  };

  const downloadRawJson = (kind: "prompt" | "workflow") => {
    if (!detail) return;
    window.open(`/api/assets/${detail.id}/raw/${kind}`, "_blank");
  };

  if (!detail) {
    return (
      <aside className="w-[460px] shrink-0 h-full bg-[#10131c] border-l border-zinc-800/90 flex items-center justify-center text-zinc-500 text-sm">
        {t("加载资源详情...", "Loading asset details...")}
      </aside>
    );
  }

  return (
    <>
      <aside
        className={`w-[460px] shrink-0 h-full bg-[#10131c] border-l border-zinc-800/90 flex flex-col overflow-hidden transition-opacity duration-100 ${
          loading ? "opacity-80" : "opacity-100"
        }`}
      >
        {/* Drawer Header */}
        <div className="h-12 px-4 border-b border-zinc-800/80 flex items-center justify-between gap-2 shrink-0">
          <div className="min-w-0">
            <div className="text-xs font-semibold text-zinc-100 truncate" title={detail.rel_path}>
              {detail.filename}
            </div>
            <div className="text-[10px] text-zinc-500 truncate">{detail.rel_path}</div>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <button
              type="button"
              onClick={() => api.revealInExplorer(detail.id)}
              className="p-1.5 rounded-lg hover:bg-zinc-800 text-zinc-400 hover:text-zinc-100"
              title={t("在文件夹中显示", "Reveal in Explorer")}
            >
              <FolderSearch className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={() => saveAssetPatch({ is_deleted: !detail.is_deleted })}
              className="p-1.5 rounded-lg hover:bg-zinc-800 text-zinc-400 hover:text-rose-400"
              title={detail.is_deleted ? t("从回收站恢复", "Restore from Trash") : t("移入回收站", "Move to Trash")}
            >
              <Trash2 className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 rounded-lg hover:bg-zinc-800 text-zinc-400 hover:text-white"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Scrollable Content */}
        <div className="flex-1 overflow-y-auto p-4 space-y-5">
          {/* Preview Box */}
          <div className="relative rounded-xl overflow-hidden bg-[#080a0f] border border-zinc-800 flex items-center justify-center max-h-[340px]">
            {detail.media_type === "video" ? (
              <video
                ref={drawerVideoRef}
                key={detail.id}
                src={detail.media_url}
                controls
                playsInline
                preload="metadata"
                title={t("双击放大播放", "Double-click to enlarge")}
                onPlay={() => window.dispatchEvent(new CustomEvent("comfyvault:pause-list-videos"))}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  drawerVideoRef.current?.pause();
                  window.dispatchEvent(new CustomEvent("comfyvault:pause-bg-videos"));
                  setLightbox(true);
                }}
                className="max-h-[340px] w-full object-contain cursor-zoom-in"
              />
            ) : (
              <img
                src={detail.media_url}
                alt={detail.filename}
                onClick={() => setLightbox(true)}
                className="max-h-[340px] w-full object-contain cursor-zoom-in"
              />
            )}
          </div>

          {/* Primary Generation Actions */}
          <div className="grid grid-cols-2 gap-2">
            <div className="flex rounded-lg overflow-hidden border border-indigo-500/40 bg-indigo-600/20">
              <button
                type="button"
                disabled={!comfyStatus.online || !detail.has_raw_prompt || rerolling}
                onClick={handleReroll}
                title={
                  !comfyStatus.online
                    ? t("请先启动 ComfyUI", "Please start ComfyUI first")
                    : !detail.has_raw_prompt
                    ? t("该文件无 API Prompt 元数据", "No API Prompt metadata in this file")
                    : t("保持当前提示词与参数不变，换新随机种再生成", "Keep current prompts and parameters, reroll with a new seed")
                }
                className="flex-1 py-2 px-2.5 text-xs font-semibold text-indigo-100 hover:bg-indigo-600/40 disabled:opacity-40 flex items-center justify-center gap-1.5 transition-colors"
              >
                <Play className="w-3.5 h-3.5 fill-current" />
                {rerolling ? t("提交中...", "Queuing...") : t("一键再生成", "Quick Reroll")}
              </button>
              <select
                value={rerollBatch}
                onChange={(e) => setRerollBatch(Number(e.target.value))}
                className="bg-indigo-950/80 text-indigo-200 text-[11px] px-1.5 border-l border-indigo-500/40 focus:outline-none"
                title={t("连抽张数", "Batch count")}
              >
                <option value={1}>×1</option>
                <option value={2}>×2</option>
                <option value={4}>×4</option>
              </select>
            </div>

            <button
              type="button"
              disabled={!detail.has_raw_prompt}
              onClick={() => onOpenRemix(detail)}
              title={t("基于此图修改提示词、LoRA权重或采样参数生成新图（原图记录保持不变）", "Modify prompts, LoRA weights, or sampling parameters to generate a new variant (original asset unchanged)")}
              className="py-2 px-3 rounded-lg bg-purple-600/25 hover:bg-purple-600/40 border border-purple-500/40 text-purple-100 text-xs font-semibold disabled:opacity-40 flex items-center justify-center gap-1.5 transition-colors"
            >
              <SlidersHorizontal className="w-3.5 h-3.5" />
              {t("微调参数派生新图", "Remix Parameters")}
            </button>
          </div>

          {/* Reference Image Compare Button (single-ref split or multi-ref N-grid) */}
          {detail.reference_image_url && (() => {
            const refs = detail.reference_images && detail.reference_images.length > 0
              ? detail.reference_images
              : [{ url: detail.reference_image_url, label: "" }];
            const isMulti = refs.length > 1;
            return (
              <button
                type="button"
                onClick={() => setShowRefCompare(true)}
                className="w-full py-2 px-3 rounded-xl bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/40 text-amber-100 text-xs font-semibold flex items-center justify-between gap-2.5 transition-colors"
              >
                <span className="flex items-center gap-2 truncate">
                  <Columns2 className="w-4 h-4 text-amber-300 shrink-0" />
                  <span className="truncate">
                    {isMulti
                      ? t(`N宫格对比原图（${refs.length} 张参考图）`, `Grid Compare (${refs.length} Ref Images)`)
                      : t("分屏对比参考原图", "Split Compare with Reference Image")}
                  </span>
                </span>
                <span className="flex items-center -space-x-1.5 shrink-0">
                  {refs.slice(0, 3).map((r, i) => (
                    <img
                      key={`${r.url}-${i}`}
                      src={r.url}
                      alt={`ref-${i + 1}`}
                      className="w-7 h-7 rounded object-cover border border-amber-400/60 bg-black"
                    />
                  ))}
                  {refs.length > 3 && (
                    <span className="w-7 h-7 rounded bg-amber-950/90 border border-amber-400/60 text-[10px] text-amber-200 font-bold flex items-center justify-center">
                      +{refs.length - 3}
                    </span>
                  )}
                </span>
              </button>
            );
          })()}

          {/* Rating, Flags & Tags */}
          <div className="p-3 rounded-xl bg-[#151925] border border-zinc-800/80 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1">
                {[1, 2, 3, 4, 5].map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => saveAssetPatch({ rating: detail.rating === s ? 0 : s })}
                    className="p-0.5 hover:scale-110 transition-transform"
                  >
                    <Star
                      className={`w-4 h-4 ${
                        s <= detail.rating ? "fill-amber-400 text-amber-400" : "text-zinc-600 hover:text-amber-300"
                      }`}
                    />
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => saveAssetPatch({ flag: detail.flag === "pick" ? "" : "pick" })}
                  className={`px-2 py-1 rounded-md text-[11px] flex items-center gap-1 border ${
                    detail.flag === "pick"
                      ? "bg-emerald-600/30 border-emerald-500 text-emerald-200"
                      : "bg-zinc-900 border-zinc-700 text-zinc-400 hover:text-emerald-300"
                  }`}
                >
                  <ThumbsUp className="w-3 h-3" /> {t("精选", "Pick")}
                </button>
                <button
                  type="button"
                  onClick={() => saveAssetPatch({ flag: detail.flag === "reject" ? "" : "reject" })}
                  className={`px-2 py-1 rounded-md text-[11px] flex items-center gap-1 border ${
                    detail.flag === "reject"
                      ? "bg-rose-600/30 border-rose-500 text-rose-200"
                      : "bg-zinc-900 border-zinc-700 text-zinc-400 hover:text-rose-300"
                  }`}
                >
                  <ThumbsDown className="w-3 h-3" /> {t("废片", "Reject")}
                </button>
              </div>
            </div>

            {/* Tags */}
            <div className="flex flex-wrap items-center gap-1.5">
              {detail.tags.map((tag) => (
                <span
                  key={tag.id}
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] bg-zinc-900 border border-zinc-700 text-zinc-200"
                >
                  <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: tag.color }} />
                  {tag.name}
                  <button
                    type="button"
                    onClick={() => handleRemoveTag(tag.id)}
                    className="text-zinc-500 hover:text-rose-400 ml-0.5"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </span>
              ))}
              <form onSubmit={handleAddTag} className="inline-flex items-center">
                <input
                  type="text"
                  value={newTag}
                  onChange={(e) => setNewTag(e.target.value)}
                  placeholder={t("+ 标签回车", "+ Tag + Enter")}
                  className="w-24 h-6 px-2 rounded-full bg-zinc-900 border border-zinc-700 focus:border-indigo-500 focus:outline-none text-[11px] text-zinc-200"
                />
              </form>
            </div>

            {/* Asset Note */}
            <div className="space-y-1">
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                onBlur={() => {
                  if (notes !== (detail.notes || "")) saveAssetPatch({ notes });
                }}
                rows={2}
                placeholder={t(
                  "记录这张图的实验笔记（例如：脸型还原度高、手部轻微崩、适合做参考图...）",
                  "Add experiment notes for this asset (e.g. accurate face likeness, minor hand artifact, good reference...)"
                )}
                className="w-full p-2 rounded-lg bg-[#0d1018] border border-zinc-800 focus:border-indigo-500 focus:outline-none text-xs text-zinc-200 placeholder:text-zinc-600 resize-none"
              />
            </div>
          </div>

          {/* Multi-Node Prompts */}
          <section className="space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-semibold text-zinc-300">
                {t("提示词节点", "Prompt Nodes")} ({detail.prompts.length})
              </h3>
              {sortedPrompts.length > 1 && (
                <button
                  type="button"
                  onClick={() =>
                    copyText(
                      sortedPrompts.map((p) => `[${p.node_title}]\n${p.text}`).join("\n\n"),
                      "all-prompts"
                    )
                  }
                  className="text-[11px] text-indigo-400 hover:text-indigo-300 flex items-center gap-1"
                >
                  <Copy className="w-3 h-3" /> {t("复制全部节点", "Copy All Nodes")}
                </button>
              )}
            </div>

            {sortedPrompts.length === 0 ? (
              <div className="text-xs text-zinc-500 p-3 rounded-lg bg-[#151925] border border-zinc-800/70">
                {t("未在文件元数据中检测到提示词节点", "No prompt nodes detected in file metadata")}
              </div>
            ) : (
              <div className="space-y-2">
                {sortedPrompts.map((p, idx) => {
                  const rs = ROLE_STYLES[p.role] || ROLE_STYLES.prompt;
                  const key = `p-${p.node_id}-${p.input_key}-${idx}`;
                  return (
                    <div key={key} className="rounded-xl bg-[#151925] border border-zinc-800/80 overflow-hidden">
                      <div className="px-3 py-1.5 bg-[#1a1f2e] border-b border-zinc-800/70 flex items-center justify-between gap-2">
                        <div className="flex items-center gap-1.5 min-w-0 flex-nowrap">
                          <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium border shrink-0 whitespace-nowrap ${rs.cls}`}>
                            {t(rs.zh, rs.en)}
                          </span>
                          <span className="text-[11px] text-zinc-300 font-medium truncate shrink whitespace-nowrap" title={p.class_type}>
                            #{p.node_id} {p.node_title}
                          </span>
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          <button
                            type="button"
                            onClick={() => handleSaveSnippet(p)}
                            className="p-1 rounded hover:bg-zinc-700/70 text-zinc-400 hover:text-amber-300"
                            title={t("收藏到提示词片段库", "Save to Prompt Snippets")}
                          >
                            <BookmarkPlus className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => copyText(p.text, key)}
                            className="px-2 py-0.5 rounded bg-zinc-800 hover:bg-indigo-600 text-[11px] text-zinc-200 flex items-center gap-1 transition-colors"
                          >
                            {copiedKey === key ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                            {t("复制", "Copy")}
                          </button>
                        </div>
                      </div>
                      <pre className="p-3 text-xs text-zinc-200 whitespace-pre-wrap break-words font-sans leading-relaxed max-h-48 overflow-y-auto select-text">
                        {p.text}
                      </pre>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          {/* LoRAs & Models */}
          <section className="space-y-2">
            <h3 className="text-xs font-semibold text-zinc-300">{t("模型与 LoRA", "Models & LoRA")}</h3>
            <div className="p-3 rounded-xl bg-[#151925] border border-zinc-800/80 space-y-2.5 text-xs">
              {detail.loras.length > 0 && (
                <div className="space-y-1.5">
                  <div className="text-[11px] text-purple-300 font-medium">LoRA ({detail.loras.length})</div>
                  {detail.loras.map((l, i) => (
                    <div
                      key={`${l.node_id}-${l.name}-${i}`}
                      className={`flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg bg-[#0d1018] border ${
                        l.enabled ? "border-purple-500/30" : "border-zinc-800 opacity-50"
                      }`}
                    >
                      <button
                        type="button"
                        onClick={() => onFilterLora(l.name)}
                        className="text-left truncate text-purple-200 hover:underline"
                        title={t(`点击筛选使用此 LoRA 的所有资源: ${l.name}`, `Click to filter all assets using this LoRA: ${l.name}`)}
                      >
                        {l.name.split("/").pop()}
                      </button>
                      <span className="font-mono text-[11px] text-zinc-300 shrink-0">
                        M:{l.strength_model} {l.strength_clip !== l.strength_model ? `/ C:${l.strength_clip}` : ""}
                        {!l.enabled && t(" (关)", " (Off)")}
                      </span>
                    </div>
                  ))}
                </div>
              )}

              {detail.models.length > 0 && (
                <div className="space-y-1">
                  <div className="text-[11px] text-sky-300 font-medium">{t("底模与其他模型", "Checkpoints & Other Models")} ({detail.models.length})</div>
                  {detail.models.map((m, i) => (
                    <div key={`${m.node_id}-${m.name}-${i}`} className="flex items-center justify-between gap-2 text-[11px] py-0.5">
                      <span className="px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400 uppercase text-[10px] shrink-0">
                        {m.category}
                      </span>
                      <span className="truncate text-zinc-200 font-mono" title={m.name}>
                        {m.name.split("/").pop()}
                      </span>
                    </div>
                  ))}
                </div>
              )}

              {detail.loras.length === 0 && detail.models.length === 0 && (
                <div className="text-zinc-500 text-xs">{t("未解析到模型或 LoRA 节点", "No model or LoRA nodes parsed")}</div>
              )}
            </div>
          </section>

          {/* Sampling Params & Environment */}
          <section className="space-y-2">
            <h3 className="text-xs font-semibold text-zinc-300">{t("参数与运行环境", "Parameters & Environment")}</h3>
            <div className="grid grid-cols-2 gap-2 text-[11px]">
              {[
                [t("生成时间", "Created"), formatTime(detail.created_at)],
                [t("ComfyUI 版本", "ComfyUI Version"), detail.comfy_version || t("历史文件(未记录)", "Legacy (unrecorded)")],
                [t("工作流", "Workflow"), detail.workflow_name || "-"],
                [t("分辨率", "Resolution"), `${detail.width} × ${detail.height}`],
                ["Seed", detail.params.seed ?? "-"],
                ["Steps / CFG", `${detail.params.steps ?? "-"} / ${detail.params.cfg ?? detail.params.guidance ?? "-"}`],
                ["Sampler", detail.params.sampler ?? "-"],
                ["Scheduler", detail.params.scheduler ?? "-"],
                [t("文件体积", "File Size"), formatBytes(detail.file_size)],
                [
                  t("生成耗时", "Gen Time"),
                  detail.gen_duration_sec
                    ? (() => {
                        const s = detail.gen_duration_sec;
                        if (s >= 3600) {
                          const h = Math.floor(s / 3600);
                          const m = Math.floor((s % 3600) / 60);
                          return t(`${h}小时${m}分`, `${h}h ${m}m`);
                        }
                        if (s >= 60) {
                          const m = Math.floor(s / 60);
                          const r = Math.round(s % 60);
                          return t(`${m}分${r}秒`, `${m}m ${r}s`);
                        }
                        return `${s.toFixed(1)}s`;
                      })()
                    : "-",
                ],
                ...(detail.media_type === "video" || detail.duration
                  ? [
                      [
                        t("视频时长", "Video Length"),
                        detail.duration
                          ? `${detail.duration}s (${detail.fps || "-"}fps)`
                          : "-",
                      ],
                    ]
                  : []),
              ].map(([k, v]) => (
                <div key={String(k)} className="px-2.5 py-1.5 rounded-lg bg-[#151925] border border-zinc-800/80">
                  <div className="text-[10px] text-zinc-500">{k}</div>
                  <div className="text-zinc-200 font-mono truncate" title={String(v)}>
                    {String(v)}
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/* Same-Recipe Batch Siblings */}
          {detail.recipe_hash && (
            <section className="space-y-2">
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-semibold text-zinc-300 flex items-center gap-1.5">
                  <Layers className="w-3.5 h-3.5 text-indigo-400" />
                  {t(`同配方抽卡记录 (${detail.siblings.length} 张)`, `Same-Recipe Batch (${detail.siblings.length})`)}
                </h3>
                <button
                  type="button"
                  onClick={() => onFilterRecipe(detail.recipe_hash!)}
                  className="text-[11px] text-indigo-400 hover:underline"
                >
                  {t("在瀑布流中查看全部", "View All in Gallery")}
                </button>
              </div>
              <div className="p-2.5 rounded-xl bg-[#151925] border border-zinc-800/80 space-y-2">
                <div className="flex gap-1.5 overflow-x-auto pb-1">
                  {detail.siblings.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => onSelectAssetId(s.id)}
                      className={`relative w-14 h-14 rounded-lg overflow-hidden shrink-0 border-2 ${
                        s.id === detail.id ? "border-indigo-500" : "border-transparent hover:border-zinc-500"
                      }`}
                      title={`Seed: ${s.seed ?? "-"} | ${s.filename}`}
                    >
                      <img src={s.thumb_url} alt={s.filename} className="w-full h-full object-cover" />
                      {s.rating > 0 && (
                        <span className="absolute bottom-0.5 right-0.5 px-1 rounded bg-black/75 text-[9px] text-amber-400">
                          ★{s.rating}
                        </span>
                      )}
                    </button>
                  ))}
                </div>
                <div className="flex gap-1.5">
                  <input
                    type="text"
                    value={recipeNote}
                    onChange={(e) => setRecipeNote(e.target.value)}
                    placeholder={t("为整组配方写一句结论（如：0.75权重+Euler最稳）...", "Write a note for this recipe group (e.g. 0.75 weight + Euler works best)...")}
                    className="flex-1 h-7 px-2 rounded bg-[#0d1018] border border-zinc-800 text-[11px] text-zinc-200 focus:outline-none focus:border-indigo-500"
                  />
                  <button
                    type="button"
                    onClick={handleSaveRecipeNote}
                    className="px-2.5 h-7 rounded bg-zinc-800 hover:bg-indigo-600 text-[11px] text-zinc-200"
                  >
                    {t("保存", "Save")}
                  </button>
                </div>
              </div>
            </section>
          )}

          {/* Lineage (Ancestors & Forked Children) */}
          {(detail.ancestors.length > 0 || detail.children.length > 0) && (
            <section className="space-y-2">
              <h3 className="text-xs font-semibold text-zinc-300 flex items-center gap-1.5">
                <GitBranch className="w-3.5 h-3.5 text-emerald-400" />
                {t("派生版本谱系", "Derivation Lineage")}
              </h3>
              <div className="p-2.5 rounded-xl bg-[#151925] border border-zinc-800/80 space-y-2 text-[11px]">
                {detail.ancestors.length > 0 && (
                  <div>
                    <div className="text-zinc-500 mb-1">{t("上游父版本", "Parent Ancestors")}</div>
                    <div className="flex items-center gap-1.5 overflow-x-auto">
                      {detail.ancestors.map((a) => (
                        <button
                          key={a.id}
                          type="button"
                          onClick={() => onSelectAssetId(a.id)}
                          className="w-12 h-12 rounded-lg overflow-hidden border border-zinc-700 hover:border-indigo-400 shrink-0"
                          title={a.filename}
                        >
                          <img src={a.thumb_url} alt={a.filename} className="w-full h-full object-cover" />
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                {detail.children.length > 0 && (
                  <div>
                    <div className="text-zinc-500 mb-1">{t("基于此图派生", "Derived Children")} ({detail.children.length})</div>
                    <div className="flex items-center gap-1.5 overflow-x-auto">
                      {detail.children.map((c) => (
                        <button
                          key={c.id}
                          type="button"
                          onClick={() => onSelectAssetId(c.id)}
                          className="w-12 h-12 rounded-lg overflow-hidden border border-zinc-700 hover:border-emerald-400 shrink-0"
                          title={c.filename}
                        >
                          <img src={c.thumb_url} alt={c.filename} className="w-full h-full object-cover" />
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </section>
          )}

          {/* Raw JSON Export */}
          <div className="flex items-center gap-2 pt-1 pb-4">
            <button
              type="button"
              disabled={!detail.has_raw_prompt}
              onClick={() => downloadRawJson("prompt")}
              className="flex-1 py-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-[11px] text-zinc-300 disabled:opacity-40 flex items-center justify-center gap-1"
            >
              <Download className="w-3.5 h-3.5" /> API Prompt JSON
            </button>
            <button
              type="button"
              disabled={!detail.has_raw_workflow}
              onClick={() => downloadRawJson("workflow")}
              className="flex-1 py-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-[11px] text-zinc-300 disabled:opacity-40 flex items-center justify-center gap-1"
            >
              <Download className="w-3.5 h-3.5" /> ComfyUI Workflow JSON
            </button>
          </div>
        </div>
      </aside>

      {/* Reference Image Split-Compare Modal */}
      {showRefCompare && detail.reference_image_url && (
        <RefCompareModal
          detail={detail}
          onClose={() => setShowRefCompare(false)}
          onOpenRemix={() => onOpenRemix(detail)}
        />
      )}

      {/* Lightbox for full image or video view */}
      {lightbox && (
        <div
          onClick={() => setLightbox(false)}
          className="fixed inset-0 z-[70] bg-black/85 flex items-center justify-center p-6 cursor-zoom-out"
        >
          <button
            type="button"
            onClick={() => setLightbox(false)}
            className="fixed top-4 right-4 z-10 p-2 rounded-xl bg-black/70 hover:bg-zinc-800 border border-white/15 text-zinc-200 hover:text-white"
            title={t("关闭 (Esc)", "Close (Esc)")}
          >
            <X className="w-5 h-5" />
          </button>
          {detail.media_type === "video" ? (
            <video
              src={detail.media_url}
              controls
              autoPlay
              playsInline
              onClick={(e) => e.stopPropagation()}
              className="max-w-[92vw] max-h-[88vh] rounded-xl shadow-2xl cursor-default"
            />
          ) : (
            <img src={detail.media_url} alt={detail.filename} className="max-w-full max-h-full object-contain rounded-lg" />
          )}
        </div>
      )}
    </>
  );
};
