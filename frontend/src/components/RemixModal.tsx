import React, { useEffect, useMemo, useState } from "react";
import { BookMarked, ImagePlus, Pin, Play, Save, Search, Shuffle, SlidersHorizontal, Wand2, Workflow, X } from "lucide-react";
import { api } from "../api";
import { useI18n } from "../i18n";
import type { AssetDetail, ComfyStatus, PromptNodeEntry, SnippetItem } from "../types";
import { InlinePromptWriterModal } from "./InlinePromptWriterModal";
import { PersistentTextarea } from "./PersistentTextarea";
import { PowerLoraEditor } from "./PowerLoraEditor";

interface Props {
  detail: AssetDetail;
  comfyStatus: ComfyStatus;
  onClose: () => void;
  onSaved?: () => void;
  onSubmitted: (msg: string) => void;
  onError: (msg: string) => void;
}

interface ComfyNodeData {
  class_type: string;
  inputs: Record<string, any>;
  _meta?: { title?: string };
}

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

function isEditableInput(val: any): boolean {
  if (val === null || val === undefined) return false;
  if (Array.isArray(val)) return false;
  if (typeof val === "object") {
    return "lora" in val && typeof val.lora === "string";
  }
  return typeof val === "string" || typeof val === "number" || typeof val === "boolean";
}

export const RemixModal: React.FC<Props> = ({ detail, comfyStatus, onClose, onSaved, onSubmitted, onError }) => {
  const { t } = useI18n();
  const pinScopeKey = detail.workflow_hash || String(detail.id);
  const [pinnedNodesMap, setPinnedNodesMap] = useState<Record<string, string[]>>(() => {
    try {
      const raw = localStorage.getItem("comfyvault_pinned_remix_nodes_v1");
      const parsed = raw ? JSON.parse(raw) : {};
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  });

  const pinnedNodeSet = useMemo(() => new Set(pinnedNodesMap[pinScopeKey] || []), [pinnedNodesMap, pinScopeKey]);

  const togglePinNode = (key: string) => {
    setPinnedNodesMap((prev) => {
      const cur = new Set(prev[pinScopeKey] || []);
      if (cur.has(key)) cur.delete(key);
      else cur.add(key);
      const next = { ...prev, [pinScopeKey]: Array.from(cur) };
      try {
        localStorage.setItem("comfyvault_pinned_remix_nodes_v1", JSON.stringify(next));
      } catch {
        // ignore quota errors
      }
      return next;
    });
  };

  const sortedPromptEntries = useMemo<PromptNodeEntry[]>(
    () =>
      detail.prompts
        .map((p) => ({ ...p }))
        .sort((a, b) => {
          const pa = pinnedNodeSet.has(`prompt::${a.node_id}::${a.input_key}`) ? 1 : 0;
          const pb = pinnedNodeSet.has(`prompt::${b.node_id}::${b.input_key}`) ? 1 : 0;
          if (pa !== pb) return pb - pa;
          return compareNodeId(a.node_id, b.node_id);
        }),
    [detail.prompts, pinnedNodeSet]
  );

  // Set of "node_id::input_key" already shown in the left prompt column so right column avoids duplicating them
  const promptFieldKeys = useMemo(
    () => new Set(sortedPromptEntries.map((p) => `${p.node_id}::${p.input_key}`)),
    [sortedPromptEntries]
  );

  const [promptJson, setPromptJson] = useState<Record<string, ComfyNodeData> | null>(null);
  const [aiWriterTarget, setAiWriterTarget] = useState<{
    nid: string;
    key: string;
    label: string;
    currentText: string;
  } | null>(null);
  const [uiTitles, setUiTitles] = useState<Record<string, string>>({});
  const [fieldOptions, setFieldOptions] = useState<Record<string, Record<string, any[]>>>({});
  const [loadingCtx, setLoadingCtx] = useState(true);

  const [nodeFilter, setNodeFilter] = useState("");
  const [randomizeSeed, setRandomizeSeed] = useState(true);
  const [batchCount, setBatchCount] = useState(1);
  const [submitting, setSubmitting] = useState(false);
  const [saving, setSaving] = useState(false);

  const [snippets, setSnippets] = useState<SnippetItem[]>([]);
  const [availableLoras, setAvailableLoras] = useState<string[]>([]);
  const [loraRanges, setLoraRanges] = useState<Record<string, { min: number; max: number; source?: string }>>({});
  const [activePromptKey, setActivePromptKey] = useState<{ nid: string; key: string } | null>(() =>
    sortedPromptEntries[0] ? { nid: sortedPromptEntries[0].node_id, key: sortedPromptEntries[0].input_key } : null
  );
  const [showSnippets, setShowSnippets] = useState(false);
  const [uploadedPreviews, setUploadedPreviews] = useState<Record<string, string>>({});

  useEffect(() => {
    setLoadingCtx(true);
    api
      .getRemixContext(detail.id)
      .then((res) => {
        setPromptJson(res.prompt_json);
        setUiTitles(res.ui_titles || {});
        setFieldOptions(res.field_options || {});
      })
      .catch((e) => onError(t(`加载完整节点失败: ${e.message}`, `Failed to load full nodes: ${e.message}`)))
      .finally(() => setLoadingCtx(false));

    api.listSnippets().then((r) => setSnippets(r.items)).catch(() => {});
    api.listComfyLoras().then((r) => {
      setAvailableLoras(r.items || []);
      setLoraRanges(r.ranges || {});
    }).catch(() => {});
  }, [detail.id]);

  const replaceNodeInputs = (nid: string, nextInputs: Record<string, any>) => {
    setPromptJson((prev) => {
      if (!prev || !prev[nid]) return prev;
      return {
        ...prev,
        [nid]: {
          ...prev[nid],
          inputs: nextInputs,
        },
      };
    });
  };

  const updateInput = (nid: string, key: string, value: any) => {
    setPromptJson((prev) => {
      if (!prev || !prev[nid]) return prev;
      return {
        ...prev,
        [nid]: {
          ...prev[nid],
          inputs: {
            ...prev[nid].inputs,
            [key]: value,
          },
        },
      };
    });
  };

  const insertSnippet = (content: string) => {
    if (!activePromptKey || !promptJson) return;
    const cur = String(promptJson[activePromptKey.nid]?.inputs?.[activePromptKey.key] ?? "");
    updateInput(activePromptKey.nid, activePromptKey.key, cur.trim() ? `${cur.trim()}, ${content}` : content);
  };

  const handleUploadImage = async (nid: string, key: string, file: File) => {
    try {
      const localUrl = URL.createObjectURL(file);
      const res = await api.uploadComfyImage(file);
      const uploadedName = res.subfolder ? `${res.subfolder}/${res.name}` : res.name;
      updateInput(nid, key, uploadedName);
      setUploadedPreviews((prev) => ({ ...prev, [`${nid}::${key}`]: localUrl }));
      onSubmitted(t(`已上传参考图至 ComfyUI: ${uploadedName}`, `Uploaded reference image to ComfyUI: ${uploadedName}`));
    } catch (e: any) {
      onError(t(`上传失败: ${e.message}`, `Upload failed: ${e.message}`));
    }
  };

  // All non-prompt adjustable nodes sorted numerically by Node ID
  const otherEditableNodes = useMemo(() => {
    if (!promptJson) return [];
    const q = nodeFilter.trim().toLowerCase();
    return Object.entries(promptJson)
      .filter(([, node]) => node && typeof node === "object" && node.inputs && typeof node.inputs === "object")
      .map(([nid, node]) => {
        const title = node._meta?.title || uiTitles[nid] || node.class_type;
        const fields = Object.entries(node.inputs).filter(
          ([k, val]) => isEditableInput(val) && !promptFieldKeys.has(`${nid}::${k}`)
        );
        return { nid, title, class_type: node.class_type, fields };
      })
      .filter((n) => n.fields.length > 0 || n.class_type.toLowerCase().includes("power lora loader"))
      .filter((n) => {
        if (!q) return true;
        return (
          n.nid.toLowerCase().includes(q) ||
          n.title.toLowerCase().includes(q) ||
          n.class_type.toLowerCase().includes(q) ||
          n.fields.some(([k, v]) => k.toLowerCase().includes(q) || String(v).toLowerCase().includes(q))
        );
      })
      .sort((a, b) => {
        const pa = pinnedNodeSet.has(a.nid) ? 1 : 0;
        const pb = pinnedNodeSet.has(b.nid) ? 1 : 0;
        if (pa !== pb) return pb - pa;
        return compareNodeId(a.nid, b.nid);
      });
  }, [promptJson, uiTitles, promptFieldKeys, nodeFilter, pinnedNodeSet]);

  const handleSave = async () => {
    if (!promptJson) return;
    setSaving(true);
    try {
      await api.saveAssetPrompt(detail.id, promptJson);
      onSaved?.();
      onSubmitted(t("已保存", "Saved"));
    } catch (e: any) {
      onError(t(`保存失败: ${e.message}`, `Save failed: ${e.message}`));
    } finally {
      setSaving(false);
    }
  };

  const handleSubmit = async () => {
    if (!comfyStatus.online) {
      onError(t("ComfyUI 当前未连接，请先启动 ComfyUI", "ComfyUI is not connected. Please start ComfyUI first."));
      return;
    }
    if (!promptJson) return;
    setSubmitting(true);
    try {
      const res = await api.remixAsset(detail.id, {
        prompt_json: promptJson,
        randomize_seed: randomizeSeed,
        batch_count: batchCount,
      });
      onSubmitted(
        t(
          `已提交 ${res.prompt_ids.length} 个无损派生任务到 ComfyUI（原图参数保持不变）`,
          `Submitted ${res.prompt_ids.length} non-destructive remix task(s) to ComfyUI (original asset remains unchanged)`
        )
      );
      onClose();
    } catch (e: any) {
      onError(t(`提交失败: ${e.message}`, `Submit failed: ${e.message}`));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-3">
      <div className="w-[96vw] max-w-7xl h-[92vh] bg-[#121622] border border-zinc-700/80 rounded-2xl shadow-2xl flex flex-col overflow-hidden">
        {/* Header */}
        <div className="px-5 py-3.5 border-b border-zinc-800 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2.5">
            <SlidersHorizontal className="w-4 h-4 text-purple-400 shrink-0" />
            <div className="min-w-0 space-y-0.5">
              <h2 className="text-sm font-semibold text-white truncate">
                {t("无损微调派生新图", "Non-destructive Remix")} — {detail.filename}
              </h2>
              <div className="flex flex-wrap items-center gap-2 text-[11px] text-emerald-300">
                <span className="inline-flex items-center gap-1 font-medium">
                  <Workflow className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                  {t("所用工作流：", "Workflow: ")}
                  <span className="text-zinc-100">
                    {detail.workflow_name || t("未命名工作流", "Unnamed Workflow")}
                  </span>
                </span>
                {detail.workflow_hash && (
                  <span className="px-1.5 py-0.2 rounded bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 font-mono text-[10px]">
                    #{detail.workflow_hash.slice(0, 6)}
                  </span>
                )}
                {detail.base_model && (
                  <span className="px-1.5 py-0.2 rounded bg-sky-500/15 border border-sky-500/30 text-sky-300 font-mono text-[10px] truncate max-w-[280px]" title={detail.base_model}>
                    {detail.base_model.split(/[\\/]/).pop()}
                  </span>
                )}
              </div>
              <p className="text-[11px] text-zinc-400">
                {t(
                  "以下修改仅用于本次提交 ComfyUI，原图记录与参数完全只读不变，新图将自动关联到派生谱系",
                  "Edits below apply only to this ComfyUI submission. The original asset stays unchanged and new outputs will be linked in lineage."
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

        {/* Body: Left Prompts (7 cols) + Right All Adjustable Parameter Nodes (5 cols) */}
        <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-12 overflow-hidden">
          {/* Left 7 cols: Prompt Nodes sorted by #node_id */}
          <div className="lg:col-span-7 h-full overflow-y-auto p-5 space-y-4 border-r border-zinc-800/80">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-zinc-200">
                {t("提示词节点编辑", "Prompt Node Editor")} ({sortedPromptEntries.length})
              </span>
              <button
                type="button"
                onClick={() => setShowSnippets((v) => !v)}
                className="px-2.5 py-1 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-[11px] text-amber-300 flex items-center gap-1"
              >
                <BookMarked className="w-3.5 h-3.5" />
                {showSnippets ? t("收起提示词库", "Hide Snippets") : t("从提示词库插入", "Insert Snippet")}
              </button>
            </div>

            {showSnippets && (
              <div className="p-2.5 rounded-xl bg-[#0b0e16] border border-amber-500/30 max-h-40 overflow-y-auto flex flex-wrap gap-1.5">
                {snippets.length === 0 ? (
                  <span className="text-[11px] text-zinc-500">
                    {t(
                      "提示词库为空，可在“提示词库”页或详情页收藏片段",
                      "Snippet library is empty. Save snippets from the Snippets tab or asset detail panel."
                    )}
                  </span>
                ) : (
                  snippets.map((sn) => (
                    <button
                      key={sn.id}
                      type="button"
                      onClick={() => insertSnippet(sn.content)}
                      className="px-2 py-1 rounded-md bg-zinc-800 hover:bg-amber-600/30 border border-zinc-700 text-[11px] text-zinc-200"
                      title={sn.content}
                    >
                      + {sn.title}
                    </button>
                  ))
                )}
              </div>
            )}

            {sortedPromptEntries.map((p, idx) => {
              const curText = String(promptJson?.[p.node_id]?.inputs?.[p.input_key] ?? p.text);
              const isFocused = activePromptKey?.nid === p.node_id && activePromptKey?.key === p.input_key;
              const pinKey = `prompt::${p.node_id}::${p.input_key}`;
              const isPinned = pinnedNodeSet.has(pinKey);
              return (
                <div
                  key={`${p.node_id}-${p.input_key}-${idx}`}
                  className={`rounded-xl border overflow-hidden ${
                    isFocused ? "border-indigo-500/70" : isPinned ? "border-amber-500/50" : "border-zinc-800"
                  }`}
                >
                  <div className="px-3.5 py-2 bg-[#181d2b] flex items-center justify-between gap-2 text-xs">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="px-1.5 py-0.5 rounded bg-indigo-600/30 border border-indigo-500/40 text-indigo-200 font-mono text-[11px] font-bold shrink-0">
                        #{p.node_id}
                      </span>
                      <span className="font-medium text-zinc-100 truncate">
                        {p.node_title} <span className="text-zinc-400 text-[11px]">({p.role})</span>
                      </span>
                      {isPinned && (
                        <span className="px-1.5 py-0.5 rounded bg-amber-500/15 border border-amber-500/30 text-amber-300 text-[10px] shrink-0">
                          {t("已置顶", "Pinned")}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <button
                        type="button"
                        onClick={() =>
                          setAiWriterTarget({
                            nid: p.node_id,
                            key: p.input_key,
                            label: `#${p.node_id} ${p.node_title} · ${p.input_key}`,
                            currentText: curText,
                          })
                        }
                        title={t(
                          "调用大模型为当前底模写提示词",
                          "Use AI LLM to write a prompt tailored to this workflow"
                        )}
                        className="h-6 px-2 rounded-md bg-indigo-500/15 hover:bg-indigo-500/30 border border-indigo-400/35 text-indigo-200 text-[11px] font-medium flex items-center gap-1 transition-colors"
                      >
                        <Wand2 className="w-3 h-3" />
                        {t("AI 写提示词", "AI Write")}
                      </button>
                      <span className="font-mono text-[11px] text-zinc-500">{p.input_key}</span>
                      <button
                        type="button"
                        onClick={() => togglePinNode(pinKey)}
                        title={isPinned ? t("取消置顶该节点", "Unpin this node") : t("置顶该节点", "Pin this node")}
                        className={`p-1 rounded-md transition-colors ${
                          isPinned
                            ? "text-amber-400 bg-amber-500/15 hover:bg-amber-500/25"
                            : "text-zinc-500 hover:text-amber-300 hover:bg-zinc-800"
                        }`}
                      >
                        <Pin className={`w-3.5 h-3.5 ${isPinned ? "fill-amber-400" : ""}`} />
                      </button>
                    </div>
                  </div>
                  <PersistentTextarea
                    storageId={`remix::${detail.workflow_hash || detail.workflow_name || detail.id}::${p.node_id}::${p.input_key}`}
                    value={curText}
                    onFocus={() => setActivePromptKey({ nid: p.node_id, key: p.input_key })}
                    onChange={(e) => updateInput(p.node_id, p.input_key, e.target.value)}
                    rows={p.role === "negative" ? 4 : Math.max(6, Math.min(12, Math.ceil(curText.length / 88)))}
                    className="w-full p-3.5 bg-[#0c0f17] text-[13px] text-zinc-100 focus:outline-none resize-y leading-relaxed"
                  />
                </div>
              );
            })}
          </div>

          {/* Right 5 cols: ALL other adjustable nodes (LoRA, Samplers, Detailers, Switches, etc.) sorted by #node_id */}
          <div className="lg:col-span-5 h-full flex flex-col overflow-hidden bg-[#0e111a]">
            <div className="px-4 py-2.5 border-b border-zinc-800 flex items-center justify-between gap-2 shrink-0">
              <span className="text-xs font-semibold text-zinc-200 whitespace-nowrap">
                {t("全部可调参数节点", "All Adjustable Parameter Nodes")} ({otherEditableNodes.length})
              </span>
              <div className="relative flex-1 max-w-[230px]">
                <Search className="w-3.5 h-3.5 text-zinc-500 absolute left-2.5 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={nodeFilter}
                  onChange={(e) => setNodeFilter(e.target.value)}
                  placeholder={t("过滤节点编号/名称/参数...", "Filter node ID / name / param...")}
                  className="w-full h-7 pl-8 pr-2 rounded-lg bg-[#141824] border border-zinc-800 text-xs text-zinc-100 focus:outline-none focus:border-indigo-500"
                />
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-3.5">
              {loadingCtx ? (
                <div className="py-12 text-center text-xs text-zinc-500">
                  {t("正在加载所有可调参数节点...", "Loading all adjustable parameter nodes...")}
                </div>
              ) : (
                otherEditableNodes.map((node) => {
                  const isLoadImage = node.class_type.toLowerCase().includes("loadimage");
                  const nodeOpts = fieldOptions[node.nid] || {};
                  const isPinned = pinnedNodeSet.has(node.nid);
                  return (
                    <div
                      key={node.nid}
                      className={`rounded-xl bg-[#141926] border overflow-hidden ${
                        isPinned ? "border-amber-500/50" : "border-zinc-800/90"
                      }`}
                    >
                      <div className="px-3 py-1.5 bg-[#1a2030] border-b border-zinc-800/80 flex items-center justify-between gap-2">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <span className="px-1.5 py-0.5 rounded bg-purple-600/30 border border-purple-500/40 text-purple-200 font-mono text-[11px] font-bold shrink-0">
                            #{node.nid}
                          </span>
                          <span className="text-xs font-semibold text-zinc-100 truncate" title={node.title}>
                            {node.title}
                          </span>
                          {isPinned && (
                            <span className="px-1.5 py-0.5 rounded bg-amber-500/15 border border-amber-500/30 text-amber-300 text-[10px] shrink-0">
                              {t("已置顶", "Pinned")}
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-1.5 shrink-0">
                          <span className="text-[10px] font-mono text-zinc-500">{node.class_type}</span>
                          <button
                            type="button"
                            onClick={() => togglePinNode(node.nid)}
                            title={isPinned ? t("取消置顶该节点", "Unpin this node") : t("置顶该节点", "Pin this node")}
                            className={`p-1 rounded-md transition-colors ${
                              isPinned
                                ? "text-amber-400 bg-amber-500/15 hover:bg-amber-500/25"
                                : "text-zinc-500 hover:text-amber-300 hover:bg-zinc-800"
                            }`}
                          >
                            <Pin className={`w-3.5 h-3.5 ${isPinned ? "fill-amber-400" : ""}`} />
                          </button>
                        </div>
                      </div>

                      <div className="p-3 grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                        {node.class_type.toLowerCase().includes("power lora loader") && promptJson?.[node.nid] ? (
                          <PowerLoraEditor
                            nodeInputs={promptJson[node.nid].inputs}
                            availableLoras={availableLoras}
                            autoRanges={loraRanges}
                            onReplaceNodeInputs={(nextInputs) => replaceNodeInputs(node.nid, nextInputs)}
                          />
                        ) : (
                          node.fields.map(([key, val]) => {
                          const kl = key.toLowerCase();
                          const choices = nodeOpts[key];

                          // 1. rgthree Power Lora Loader
                          if (typeof val === "object" && val !== null && "lora" in val) {
                            const on = Boolean(val.on ?? true);
                            const strength = Number(val.strength ?? 1.0);
                            return (
                              <div
                                key={key}
                                className="sm:col-span-2 p-2 rounded-lg bg-[#0d1018] border border-purple-500/25 space-y-1.5"
                              >
                                <div className="flex items-center justify-between gap-2">
                                  <label className="flex items-center gap-1.5 text-[11px] text-zinc-200 truncate cursor-pointer">
                                    <input
                                      type="checkbox"
                                      checked={on}
                                      onChange={(e) => updateInput(node.nid, key, { ...val, on: e.target.checked })}
                                      className="accent-purple-500 shrink-0"
                                    />
                                    <span className="truncate font-mono" title={String(val.lora)}>
                                      {String(val.lora).split(/[\\/]/).pop()}
                                    </span>
                                  </label>
                                  <span className="font-mono text-[11px] text-purple-300 shrink-0">
                                    {strength.toFixed(2)}
                                  </span>
                                </div>
                                <input
                                  type="range"
                                  min={-0.5}
                                  max={2.0}
                                  step={0.05}
                                  disabled={!on}
                                  value={strength}
                                  onChange={(e) =>
                                    updateInput(node.nid, key, { ...val, strength: Number(e.target.value) })
                                  }
                                  className="w-full accent-purple-500"
                                />
                              </div>
                            );
                          }

                          // 2. Boolean
                          if (typeof val === "boolean") {
                            return (
                              <label
                                key={key}
                                className="flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg bg-[#0d1018] border border-zinc-800 cursor-pointer"
                              >
                                <span className="text-[11px] text-zinc-300 font-mono truncate">{key}</span>
                                <input
                                  type="checkbox"
                                  checked={val}
                                  onChange={(e) => updateInput(node.nid, key, e.target.checked)}
                                  className="accent-indigo-500 shrink-0"
                                />
                              </label>
                            );
                          }

                          // 3. Number
                          if (typeof val === "number") {
                            const isFloat =
                              !Number.isInteger(val) ||
                              ["cfg", "denoise", "strength", "weight", "guidance", "scale", "factor"].some((w) =>
                                kl.includes(w)
                              );
                            const isSeed =
                              kl === "seed" || kl === "noise_seed" || kl === "seed_num" || kl === "random_seed";
                            return (
                              <div key={key} className="space-y-0.5">
                                <div className="flex items-center justify-between text-[10px]">
                                  <span className="text-zinc-400 font-mono truncate">{key}</span>
                                  {isSeed && randomizeSeed && <span className="text-indigo-400">{t("自动随机", "Auto-random")}</span>}
                                </div>
                                <input
                                  type="number"
                                  step={isFloat ? "0.05" : "1"}
                                  value={val}
                                  onChange={(e) =>
                                    updateInput(node.nid, key, e.target.value === "" ? 0 : Number(e.target.value))
                                  }
                                  className="w-full h-7 px-2 rounded bg-[#0d1018] border border-zinc-700 focus:border-indigo-500 focus:outline-none text-xs font-mono text-zinc-100"
                                />
                              </div>
                            );
                          }

                          const strVal = String(val);

                          // Hide dummy upload button placeholder widget_1="image" on offline LoadImage
                          if (isLoadImage && kl === "widget_1" && strVal.toLowerCase() === "image") {
                            return null;
                          }

                          // 4. LoadImage upload with thumbnail preview (works online 'image' & offline 'widget_0')
                          if (isLoadImage && (kl === "image" || kl === "widget_0")) {
                            const previewSrc =
                              uploadedPreviews[`${node.nid}::${key}`] ||
                              (strVal ? `/api/comfy/input-image?name=${encodeURIComponent(strVal)}` : "");
                            return (
                              <div key={key} className="sm:col-span-2 space-y-1.5">
                                <span className="text-[10px] text-zinc-400 font-mono">
                                  {key} ({t("参考图", "Reference Image")})
                                </span>
                                <div className="flex items-start gap-2.5">
                                  {previewSrc && (
                                    <div className="w-20 h-20 rounded-lg overflow-hidden bg-[#0a0c12] border border-zinc-700/80 shrink-0">
                                      <img
                                        key={previewSrc}
                                        src={previewSrc}
                                        alt={strVal}
                                        onError={(e) => {
                                          (e.currentTarget.parentElement as HTMLElement).style.display = "none";
                                        }}
                                        className="w-full h-full object-cover"
                                      />
                                    </div>
                                  )}
                                  <div className="flex-1 flex items-center gap-1.5 min-w-0">
                                    <input
                                      type="text"
                                      value={strVal}
                                      onChange={(e) => {
                                        setUploadedPreviews((prev) => {
                                          const next = { ...prev };
                                          delete next[`${node.nid}::${key}`];
                                          return next;
                                        });
                                        updateInput(node.nid, key, e.target.value);
                                      }}
                                      className="flex-1 h-7 px-2 rounded bg-[#0d1018] border border-zinc-700 text-xs font-mono text-zinc-100"
                                    />
                                    <label className="h-7 px-2.5 rounded bg-sky-600/25 hover:bg-sky-600/40 border border-sky-500/40 text-sky-200 text-[11px] flex items-center gap-1 cursor-pointer shrink-0">
                                      <ImagePlus className="w-3 h-3" />
                                      {t("上传", "Upload")}
                                      <input
                                        type="file"
                                        accept="image/*"
                                        className="hidden"
                                        onChange={(e) => {
                                          const f = e.target.files?.[0];
                                          if (f) handleUploadImage(node.nid, key, f);
                                          e.target.value = "";
                                        }}
                                      />
                                    </label>
                                  </div>
                                </div>
                              </div>
                            );
                          }

                          // 5. Real ComfyUI Combo Dropdown
                          if (Array.isArray(choices) && choices.length > 0 && choices.length <= 500) {
                            const hasVal = choices.includes(strVal);
                            return (
                              <div key={key} className="sm:col-span-2 space-y-0.5">
                                <span className="text-[10px] text-zinc-400 font-mono">{key}</span>
                                <select
                                  value={strVal}
                                  onChange={(e) => updateInput(node.nid, key, e.target.value)}
                                  className="w-full h-7 px-2 rounded bg-[#0d1018] border border-zinc-700 focus:border-indigo-500 focus:outline-none text-xs font-mono text-zinc-100"
                                >
                                  {!hasVal && <option value={strVal}>{strVal}</option>}
                                  {choices.map((opt) => (
                                    <option key={String(opt)} value={String(opt)}>
                                      {String(opt)}
                                    </option>
                                  ))}
                                </select>
                              </div>
                            );
                          }

                          // 6. Standard short string
                          return (
                            <div key={key} className="space-y-0.5">
                              <span className="text-[10px] text-zinc-400 font-mono truncate block">{key}</span>
                              <input
                                type="text"
                                value={strVal}
                                onChange={(e) => updateInput(node.nid, key, e.target.value)}
                                className="w-full h-7 px-2 rounded bg-[#0d1018] border border-zinc-700 focus:border-indigo-500 focus:outline-none text-xs font-mono text-zinc-100"
                              />
                            </div>
                          );
                        })
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-zinc-800 bg-[#0e111a] flex flex-wrap items-center justify-between gap-3 shrink-0">
          <div className="flex items-center gap-4 text-xs">
            <label className="flex items-center gap-1.5 text-zinc-200 cursor-pointer">
              <input
                type="checkbox"
                checked={randomizeSeed}
                onChange={(e) => setRandomizeSeed(e.target.checked)}
                className="accent-indigo-500"
              />
              <Shuffle className="w-3.5 h-3.5 text-indigo-400" />
              {t("自动随机化所有 Seed", "Randomize all Seeds")}
            </label>
            <div className="flex items-center gap-1.5">
              <span className="text-zinc-400">{t("本次生成张数", "Batch Count")}</span>
              {[1, 2, 4].map((n) => (
                <button
                  key={n}
                  type="button"
                  onClick={() => setBatchCount(n)}
                  className={`px-2.5 py-1 rounded text-xs font-medium ${
                    batchCount === n ? "bg-indigo-600 text-white" : "bg-zinc-800 text-zinc-300"
                  }`}
                >
                  ×{n}
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <span className="text-xs text-zinc-400 mr-1">
              {t("ComfyUI：", "ComfyUI: ")}
              <span className={comfyStatus.online ? "text-emerald-400 font-medium" : "text-rose-400 font-medium"}>
                {comfyStatus.online ? t("在线就绪", "Online") : t("离线", "Offline")}
              </span>
            </span>
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-xs text-zinc-200"
            >
              {t("取消", "Cancel")}
            </button>
            <button
              type="button"
              disabled={!promptJson || saving}
              onClick={handleSave}
              title={t(
                "直接覆盖保存当前修改的参数与提示词（不关闭弹窗）",
                "Overwrite and save current parameter and prompt edits (keeps modal open)"
              )}
              className="px-4 py-1.5 rounded-lg bg-emerald-600/25 hover:bg-emerald-600/40 border border-emerald-500/40 disabled:opacity-40 text-xs font-semibold text-emerald-200 flex items-center gap-1.5 transition-colors"
            >
              <Save className="w-3.5 h-3.5" />
              {saving ? t("保存中...", "Saving...") : t("保存", "Save")}
            </button>
            <button
              type="button"
              disabled={!comfyStatus.online || !promptJson || submitting}
              onClick={handleSubmit}
              className="px-5 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-xs font-semibold text-white flex items-center gap-1.5"
            >
              <Play className="w-3.5 h-3.5 fill-current" />
              {submitting ? t("正在提交...", "Submitting...") : t(`提交生成 (×${batchCount})`, `Generate (×${batchCount})`)}
            </button>
          </div>
        </div>
      </div>

      {aiWriterTarget && (
        <InlinePromptWriterModal
          promptJson={promptJson}
          workflowName={detail.workflow_name || undefined}
          baseModel={detail.base_model}
          currentText={aiWriterTarget.currentText}
          nodeLabel={aiWriterTarget.label}
          onClose={() => setAiWriterTarget(null)}
          onInsertText={(text) => updateInput(aiWriterTarget.nid, aiWriterTarget.key, text)}
          onToast={(msg, tone) => (tone === "err" ? onError(msg) : onSubmitted(msg))}
        />
      )}
    </div>
  );
};
