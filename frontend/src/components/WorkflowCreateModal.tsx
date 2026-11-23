import React, { useEffect, useMemo, useState } from "react";
import {
  BookMarked,
  FileCode2,
  Folder,
  ImagePlus,
  Pin,
  Play,
  RefreshCw,
  Save,
  Search,
  Settings,
  Shuffle,
  Workflow,
  X,
} from "lucide-react";
import { api, formatTime } from "../api";
import { useI18n } from "../i18n";
import type { ComfyStatus, SnippetItem, WorkflowFileItem } from "../types";
import { PowerLoraEditor } from "./PowerLoraEditor";
import type { WorkflowPrefillPayload } from "./PromptConverterModal";

interface Props {
  comfyStatus: ComfyStatus;
  initialPrefill?: WorkflowPrefillPayload | null;
  onClose: () => void;
  onOpenSettings: () => void;
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

const MULTILINE_KEYS = new Set([
  "text",
  "prompt",
  "positive",
  "negative",
  "positive_prompt",
  "negative_prompt",
  "text_g",
  "text_l",
  "clip_l",
  "t5xxl",
  "system_prompt",
  "user_prompt",
  "caption",
  "string",
]);

function isEditableInput(val: any): boolean {
  if (val === null || val === undefined) return false;
  if (Array.isArray(val)) return false;
  if (typeof val === "object") {
    return "lora" in val && typeof val.lora === "string";
  }
  return typeof val === "string" || typeof val === "number" || typeof val === "boolean";
}

export const WorkflowCreateModal: React.FC<Props> = ({
  comfyStatus,
  initialPrefill,
  onClose,
  onOpenSettings,
  onSubmitted,
  onError,
}) => {
  const { t } = useI18n();
  const [workflowDirs, setWorkflowDirs] = useState<string[]>([]);
  const [files, setFiles] = useState<WorkflowFileItem[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [fileSearch, setFileSearch] = useState("");
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [activeName, setActiveName] = useState("");

  const [promptJson, setPromptJson] = useState<Record<string, ComfyNodeData> | null>(null);
  const [workflowJson, setWorkflowJson] = useState<any>(null);
  const [uiTitles, setUiTitles] = useState<Record<string, string>>({});
  const [fieldOptions, setFieldOptions] = useState<Record<string, Record<string, any[]>>>({});
  const [loadingWf, setLoadingWf] = useState(false);

  const [nodeFilter, setNodeFilter] = useState("");
  const [randomizeSeed, setRandomizeSeed] = useState(true);
  const [batchCount, setBatchCount] = useState(1);
  const [submitting, setSubmitting] = useState(false);
  const [saving, setSaving] = useState(false);

  const [snippets, setSnippets] = useState<SnippetItem[]>([]);
  const [availableLoras, setAvailableLoras] = useState<string[]>([]);
  const [loraRanges, setLoraRanges] = useState<Record<string, { min: number; max: number; source?: string }>>({});
  const [showSnippets, setShowSnippets] = useState(false);
  const [focusedField, setFocusedField] = useState<{ nid: string; key: string } | null>(null);
  const [uploadedPreviews, setUploadedPreviews] = useState<Record<string, string>>({});
  const [pinnedPaths, setPinnedPaths] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem("comfyvault_pinned_workflows");
      return new Set(raw ? JSON.parse(raw) : []);
    } catch {
      return new Set();
    }
  });
  const [pinnedNodesMap, setPinnedNodesMap] = useState<Record<string, string[]>>(() => {
    try {
      const raw = localStorage.getItem("comfyvault_pinned_wf_nodes_v1");
      const parsed = raw ? JSON.parse(raw) : {};
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  });

  const pinnedNodeSet = useMemo(() => {
    if (!selectedPath) return new Set<string>();
    return new Set(pinnedNodesMap[selectedPath] || []);
  }, [pinnedNodesMap, selectedPath]);

  const togglePinNode = (nid: string) => {
    if (!selectedPath) return;
    setPinnedNodesMap((prev) => {
      const cur = new Set(prev[selectedPath] || []);
      if (cur.has(nid)) cur.delete(nid);
      else cur.add(nid);
      const next = { ...prev, [selectedPath]: Array.from(cur) };
      try {
        localStorage.setItem("comfyvault_pinned_wf_nodes_v1", JSON.stringify(next));
      } catch {
        // ignore quota errors
      }
      return next;
    });
  };

  const togglePin = (e: React.MouseEvent, filePath: string) => {
    e.stopPropagation();
    setPinnedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(filePath)) next.delete(filePath);
      else next.add(filePath);
      try {
        localStorage.setItem("comfyvault_pinned_workflows", JSON.stringify(Array.from(next)));
      } catch {}
      return next;
    });
  };

  const scanFiles = (prefill?: WorkflowPrefillPayload | null) => {
    setLoadingList(true);
    api
      .listWorkflowFiles()
      .then((res) => {
        setWorkflowDirs(res.workflow_dirs || []);
        const list = res.items || [];
        setFiles(list);
        if (prefill?.workflowPath) {
          selectFile(prefill.workflowPath, prefill);
        } else if (!selectedPath && list.length > 0) {
          const firstPinned = list.find((f) => pinnedPaths.has(f.path));
          selectFile((firstPinned || list[0]).path);
        }
      })
      .catch((e) => onError(t(`扫描工作流目录失败: ${e.message}`, `Failed to scan workflow directory: ${e.message}`)))
      .finally(() => setLoadingList(false));
  };

  useEffect(() => {
    scanFiles(initialPrefill);
    api.listSnippets().then((r) => setSnippets(r.items)).catch(() => {});
    api.listComfyLoras().then((r) => {
      setAvailableLoras(r.items || []);
      setLoraRanges(r.ranges || {});
    }).catch(() => {});
  }, []);

  const selectFile = async (filePath: string, prefill?: WorkflowPrefillPayload | null) => {
    setSelectedPath(filePath);
    setLoadingWf(true);
    try {
      const res = await api.loadWorkflowFile(filePath);
      setActiveName(res.name);
      const nextPrompt = { ...(res.prompt_json || {}) };
      if (prefill?.text) {
        let applied = false;
        if (prefill.nodeId && nextPrompt[prefill.nodeId]?.inputs) {
          const inputs = { ...nextPrompt[prefill.nodeId].inputs };
          const key = prefill.inputKey && keyExists(inputs, prefill.inputKey) ? prefill.inputKey : Object.keys(inputs).find((k) => MULTILINE_KEYS.has(k.toLowerCase()));
          if (key) {
            inputs[key] = prefill.text;
            nextPrompt[prefill.nodeId] = { ...nextPrompt[prefill.nodeId], inputs };
            applied = true;
          }
        }
        if (!applied) {
          // Fallback: find first editable multiline text input across nodes
          for (const nid of Object.keys(nextPrompt)) {
            const node = nextPrompt[nid];
            if (!node?.inputs) continue;
            const k = Object.keys(node.inputs).find((ik) => MULTILINE_KEYS.has(ik.toLowerCase()) && typeof node.inputs[ik] === "string");
            if (k) {
              nextPrompt[nid] = { ...node, inputs: { ...node.inputs, [k]: prefill.text } };
              applied = true;
              break;
            }
          }
        }
        if (applied) {
          onSubmitted(
            t(
              `已自动填入转换后的提示词${prefill.nodeId ? `（节点 #${prefill.nodeId}）` : ""}，请检阅后点击创建`,
              `Auto-filled converted prompt${prefill.nodeId ? ` (Node #${prefill.nodeId})` : ""}. Please review and click Generate.`
            )
          );
        }
      }
      setPromptJson(nextPrompt);
      setWorkflowJson(res.workflow_json);
      setUiTitles(res.ui_titles || {});
      setFieldOptions(res.field_options || {});
    } catch (e: any) {
      onError(t(`解析工作流失败: ${e.message}`, `Failed to parse workflow: ${e.message}`));
    } finally {
      setLoadingWf(false);
    }
  };

  function keyExists(obj: Record<string, any>, k: string): boolean {
    return Object.prototype.hasOwnProperty.call(obj, k);
  }

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

  const handleUploadImageForNode = async (nid: string, key: string, file: File) => {
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

  const insertSnippet = (content: string) => {
    if (!focusedField || !promptJson) {
      onError(t("请先点击一个提示词输入框", "Please click a prompt input box first"));
      return;
    }
    const cur = String(promptJson[focusedField.nid]?.inputs?.[focusedField.key] ?? "");
    updateInput(focusedField.nid, focusedField.key, cur.trim() ? `${cur.trim()}, ${content}` : content);
  };

  // All editable nodes strictly sorted by numeric Node ID
  const editableNodes = useMemo(() => {
    if (!promptJson) return [];
    const q = nodeFilter.trim().toLowerCase();
    return Object.entries(promptJson)
      .filter(([, node]) => node && typeof node === "object" && node.inputs && typeof node.inputs === "object")
      .map(([nid, node]) => {
        const title = node._meta?.title || uiTitles[nid] || node.class_type;
        const fields = Object.entries(node.inputs).filter(([, val]) => isEditableInput(val));
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
  }, [promptJson, uiTitles, nodeFilter, pinnedNodeSet]);

  const filteredFiles = useMemo(() => {
    const q = fileSearch.trim().toLowerCase();
    const matched = q
      ? files.filter((f) => f.name.toLowerCase().includes(q) || f.folder.toLowerCase().includes(q))
      : files;
    return [...matched].sort((a, b) => {
      const pa = pinnedPaths.has(a.path) ? 1 : 0;
      const pb = pinnedPaths.has(b.path) ? 1 : 0;
      if (pa !== pb) return pb - pa;
      return b.mtime - a.mtime;
    });
  }, [files, fileSearch, pinnedPaths]);

  const handleSaveToWorkflow = async () => {
    if (!selectedPath || !promptJson) return;
    setSaving(true);
    try {
      const res = await api.saveWorkflowFile(selectedPath, promptJson);
      setFiles((prev) =>
        prev.map((f) => (f.path === selectedPath ? { ...f, mtime: res.mtime } : f))
      );
      onSubmitted(
        t(
          `已保存修改到工作流文件（更新 ${res.updated_nodes} 个节点）`,
          `Saved changes to workflow file (${res.updated_nodes} node(s) updated)`
        )
      );
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
      const res = await api.runWorkflow({
        prompt_json: promptJson,
        workflow_json: workflowJson,
        randomize_seed: randomizeSeed,
        batch_count: batchCount,
      });
      onSubmitted(
        t(
          `工作流已提交 ${res.prompt_ids.length} 个生成任务到 ComfyUI！`,
          `Submitted ${res.prompt_ids.length} workflow generation task(s) to ComfyUI!`
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
      <div className="w-[96vw] max-w-7xl h-[92vh] bg-[#10141f] border border-zinc-700/90 rounded-2xl shadow-2xl flex flex-col overflow-hidden">
        {/* Header */}
        <div className="px-5 py-3 border-b border-zinc-800 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2.5">
            <Workflow className="w-5 h-5 text-indigo-400" />
            <div>
              <h2 className="text-sm font-semibold text-white">
                {t("从工作流目录创建生成", "Create from Workflow Directory")}
              </h2>
              <p className="text-[11px] text-zinc-400 truncate max-w-[60vw]">
                {t("当前扫描目录：", "Scanned directories: ")}
                {workflowDirs.length > 0 ? workflowDirs.join(" ; ") : t("未配置", "Not configured")}
                {t(`（共 ${files.length} 个工作流）`, ` (${files.length} workflow(s))`)}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => scanFiles()}
              className="px-2.5 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-xs text-zinc-200 flex items-center gap-1.5"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loadingList ? "animate-spin text-indigo-400" : ""}`} />
              {t("重新扫描", "Rescan")}
            </button>
            <button
              type="button"
              onClick={onOpenSettings}
              className="px-3 py-1.5 rounded-lg bg-indigo-600/20 hover:bg-indigo-600/35 border border-indigo-500/40 text-xs text-indigo-200 flex items-center gap-1.5"
            >
              <Settings className="w-3.5 h-3.5" />
              {t("配置工作流目录", "Configure Workflow Dirs")}
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

        {/* Body */}
        <div className="flex-1 min-h-0 flex overflow-hidden">
          {/* Left: Scanned Workflow Files */}
          <div className="w-80 shrink-0 border-r border-zinc-800 bg-[#0d1018] flex flex-col">
            <div className="p-2.5 border-b border-zinc-800">
              <div className="relative">
                <Search className="w-3.5 h-3.5 text-zinc-500 absolute left-2.5 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={fileSearch}
                  onChange={(e) => setFileSearch(e.target.value)}
                  placeholder={t("搜索工作流文件名或子目录...", "Search workflow filename or subfolder...")}
                  className="w-full h-8 pl-8 pr-2 rounded-lg bg-[#141824] border border-zinc-800 text-xs text-zinc-100 focus:outline-none focus:border-indigo-500"
                />
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-2 space-y-1">
              {loadingList ? (
                <div className="text-center py-8 text-xs text-zinc-500">
                  {t("正在扫描工作流目录...", "Scanning workflow directories...")}
                </div>
              ) : filteredFiles.length === 0 ? (
                <div className="text-center py-8 px-4 text-xs text-zinc-500 space-y-2">
                  <div>{t("未找到工作流 JSON 文件", "No workflow JSON files found")}</div>
                  <button
                    type="button"
                    onClick={onOpenSettings}
                    className="px-3 py-1.5 rounded-lg bg-indigo-600 text-white text-xs"
                  >
                    {t("配置工作流目录", "Configure Workflow Dirs")}
                  </button>
                </div>
              ) : (
                filteredFiles.map((f) => {
                  const active = selectedPath === f.path;
                  const pinned = pinnedPaths.has(f.path);
                  return (
                    <div
                      key={f.path}
                      role="button"
                      tabIndex={0}
                      onClick={() => selectFile(f.path)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          selectFile(f.path);
                        }
                      }}
                      className={`group w-full text-left p-2.5 rounded-xl border transition-colors cursor-pointer ${
                        active
                          ? "bg-indigo-600/20 border-indigo-500/60"
                          : pinned
                          ? "bg-[#151a28] border-amber-500/35 hover:border-amber-400/60"
                          : "bg-[#131722] border-zinc-800/70 hover:border-zinc-700"
                      }`}
                    >
                      <div className="flex items-start gap-2">
                        <FileCode2 className={`w-4 h-4 mt-0.5 shrink-0 ${active ? "text-indigo-400" : pinned ? "text-amber-400" : "text-zinc-500"}`} />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-start justify-between gap-1.5">
                            <div className="text-xs font-medium text-zinc-100 break-words leading-snug" title={f.name}>
                              {f.name}
                            </div>
                            <button
                              type="button"
                              onClick={(e) => togglePin(e, f.path)}
                              title={pinned ? t("取消置顶", "Unpin") : t("置顶常用工作流", "Pin favorite workflow")}
                              className={`p-1 rounded-md shrink-0 transition-all ${
                                pinned
                                  ? "text-amber-400 bg-amber-500/15 hover:bg-amber-500/25 opacity-100"
                                  : "text-zinc-500 hover:text-amber-300 hover:bg-zinc-800 opacity-0 group-hover:opacity-100"
                              }`}
                            >
                              <Pin className={`w-3.5 h-3.5 ${pinned ? "fill-amber-400" : ""}`} />
                            </button>
                          </div>
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 mt-1 text-[10px] text-zinc-500">
                            {pinned && (
                              <span className="px-1 rounded bg-amber-500/20 text-amber-300 font-medium">
                                {t("置顶", "Pinned")}
                              </span>
                            )}
                            {f.folder && (
                              <span className="inline-flex items-center gap-0.5 text-amber-400/80 truncate max-w-[130px]">
                                <Folder className="w-2.5 h-2.5" /> {f.folder}
                              </span>
                            )}
                            <span className="px-1 rounded bg-zinc-800 text-zinc-400 uppercase">{f.format}</span>
                            <span className="font-mono">{t(`${f.node_count} 节点`, `${f.node_count} nodes`)}</span>
                            <span className="font-mono text-zinc-400">{formatTime(f.mtime)}</span>
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>

          {/* Right: All Editable Nodes Sorted by Node ID */}
          <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
            <div className="px-5 py-2.5 border-b border-zinc-800 bg-[#131723] flex flex-wrap items-center justify-between gap-3 shrink-0">
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-xs font-semibold text-white truncate">
                  {activeName || t("请选择左侧工作流", "Select a workflow on the left")}
                </span>
                <span className="px-2 py-0.5 rounded-full bg-zinc-800 text-[11px] text-zinc-300 font-mono shrink-0">
                  {t(`${editableNodes.length} 个可输入节点`, `${editableNodes.length} editable nodes`)}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <div className="relative w-56">
                  <Search className="w-3.5 h-3.5 text-zinc-500 absolute left-2.5 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    value={nodeFilter}
                    onChange={(e) => setNodeFilter(e.target.value)}
                    placeholder={t("过滤节点编号/标题/参数...", "Filter node ID / title / param...")}
                    className="w-full h-7 pl-8 pr-2 rounded-lg bg-[#0c0f17] border border-zinc-800 text-xs text-zinc-100 focus:outline-none focus:border-indigo-500"
                  />
                </div>
                <button
                  type="button"
                  onClick={() => setShowSnippets((v) => !v)}
                  className="h-7 px-2.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-[11px] text-amber-300 flex items-center gap-1"
                >
                  <BookMarked className="w-3.5 h-3.5" />
                  {showSnippets ? t("收起词库", "Hide Snippets") : t("提示词库", "Snippets")}
                </button>
              </div>
            </div>

            {showSnippets && (
              <div className="px-5 py-2 bg-[#0b0e16] border-b border-amber-500/30 max-h-32 overflow-y-auto flex flex-wrap gap-1.5 shrink-0">
                {snippets.length === 0 ? (
                  <span className="text-[11px] text-zinc-500">{t("提示词库为空", "Snippet library is empty")}</span>
                ) : (
                  snippets.map((sn) => (
                    <button
                      key={sn.id}
                      type="button"
                      onClick={() => insertSnippet(sn.content)}
                      className="px-2 py-1 rounded bg-zinc-800 hover:bg-amber-600/30 border border-zinc-700 text-[11px] text-zinc-200"
                      title={sn.content}
                    >
                      + {sn.title}
                    </button>
                  ))
                )}
              </div>
            )}

            <div className="flex-1 overflow-y-auto p-5 space-y-4">
              {loadingWf ? (
                <div className="py-20 text-center text-sm text-zinc-500">
                  {t("正在解析工作流节点与 ComfyUI 参数定义...", "Parsing workflow nodes and ComfyUI parameter definitions...")}
                </div>
              ) : !promptJson ? (
                <div className="py-20 text-center text-sm text-zinc-500">
                  {t("请从左侧选择一个工作流文件", "Please select a workflow file from the left")}
                </div>
              ) : (
                editableNodes.map((node) => {
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
                      <div className="px-4 py-2 bg-[#1a2030] border-b border-zinc-800/80 flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="px-2 py-0.5 rounded-md bg-indigo-600/30 border border-indigo-500/40 text-indigo-200 font-mono text-xs font-bold shrink-0">
                            #{node.nid}
                          </span>
                          <span className="text-xs font-semibold text-zinc-100 truncate">{node.title}</span>
                          {isPinned && (
                            <span className="px-1.5 py-0.5 rounded bg-amber-500/15 border border-amber-500/30 text-amber-300 text-[10px] shrink-0">
                              {t("已置顶", "Pinned")}
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <span className="text-[11px] font-mono text-zinc-500">{node.class_type}</span>
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

                      <div className="p-4 grid grid-cols-1 md:grid-cols-2 gap-3.5">
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

                          // 1. rgthree Power Lora Loader dict
                          if (typeof val === "object" && val !== null && "lora" in val) {
                            const on = Boolean(val.on ?? true);
                            const strength = Number(val.strength ?? 1.0);
                            return (
                              <div
                                key={key}
                                className="md:col-span-2 p-2.5 rounded-lg bg-[#0d1018] border border-purple-500/25 flex flex-wrap items-center gap-3"
                              >
                                <label className="flex items-center gap-1.5 text-xs text-purple-200 cursor-pointer shrink-0">
                                  <input
                                    type="checkbox"
                                    checked={on}
                                    onChange={(e) => updateInput(node.nid, key, { ...val, on: e.target.checked })}
                                    className="accent-purple-500"
                                  />
                                  <span className="font-mono text-[11px] text-zinc-400">{key}</span>
                                </label>
                                <input
                                  type="text"
                                  value={String(val.lora || "")}
                                  onChange={(e) => updateInput(node.nid, key, { ...val, lora: e.target.value })}
                                  className="flex-1 min-w-[200px] h-7 px-2 rounded bg-[#141926] border border-zinc-700 text-xs text-zinc-100 font-mono"
                                />
                                <div className="flex items-center gap-2 w-44 shrink-0">
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
                                    className="flex-1 accent-purple-500"
                                  />
                                  <span className="w-10 text-right font-mono text-xs text-purple-300">
                                    {strength.toFixed(2)}
                                  </span>
                                </div>
                              </div>
                            );
                          }

                          // 2. Boolean toggle
                          if (typeof val === "boolean") {
                            return (
                              <label
                                key={key}
                                className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg bg-[#0d1018] border border-zinc-800 cursor-pointer"
                              >
                                <span className="text-xs text-zinc-300 font-mono">{key}</span>
                                <input
                                  type="checkbox"
                                  checked={val}
                                  onChange={(e) => updateInput(node.nid, key, e.target.checked)}
                                  className="w-4 h-4 accent-indigo-500"
                                />
                              </label>
                            );
                          }

                          // 3. Number
                          if (typeof val === "number") {
                            const isFloat =
                              !Number.isInteger(val) ||
                              ["cfg", "denoise", "strength", "weight", "guidance"].some((w) => kl.includes(w));
                            const isSeed =
                              kl === "seed" || kl === "noise_seed" || kl === "seed_num" || kl === "random_seed";
                            return (
                              <div key={key} className="space-y-1">
                                <div className="flex items-center justify-between text-[11px]">
                                  <span className="text-zinc-400 font-mono">{key}</span>
                                  {isSeed && randomizeSeed && (
                                    <span className="text-[10px] text-indigo-400">
                                      {t("提交时自动随机", "Auto-randomized on submit")}
                                    </span>
                                  )}
                                </div>
                                <input
                                  type="number"
                                  step={isFloat ? "0.05" : "1"}
                                  value={val}
                                  onChange={(e) =>
                                    updateInput(node.nid, key, e.target.value === "" ? 0 : Number(e.target.value))
                                  }
                                  className="w-full h-8 px-2.5 rounded-lg bg-[#0d1018] border border-zinc-700 focus:border-indigo-500 focus:outline-none text-xs font-mono text-zinc-100"
                                />
                              </div>
                            );
                          }

                          const strVal = String(val);

                          // Hide dummy upload button placeholder widget_1="image" on offline LoadImage
                          if (isLoadImage && kl === "widget_1" && strVal.toLowerCase() === "image") {
                            return null;
                          }

                          // 4. LoadImage with upload button & thumbnail preview (works online 'image' & offline 'widget_0')
                          if (isLoadImage && (kl === "image" || kl === "widget_0")) {
                            const previewSrc =
                              uploadedPreviews[`${node.nid}::${key}`] ||
                              (strVal ? `/api/comfy/input-image?name=${encodeURIComponent(strVal)}` : "");
                            return (
                              <div key={key} className="md:col-span-2 space-y-2">
                                <span className="text-[11px] text-zinc-400 font-mono">
                                  {key} ({t("输入图片", "Input Image")})
                                </span>
                                <div className="flex items-start gap-3">
                                  {previewSrc && (
                                    <div className="w-24 h-24 rounded-lg overflow-hidden bg-[#0a0c12] border border-zinc-700/80 shrink-0 flex items-center justify-center">
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
                                  <div className="flex-1 flex items-center gap-2 min-w-0">
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
                                      className="flex-1 h-8 px-2.5 rounded-lg bg-[#0d1018] border border-zinc-700 text-xs font-mono text-zinc-100"
                                    />
                                    <label className="h-8 px-3 rounded-lg bg-sky-600/25 hover:bg-sky-600/40 border border-sky-500/40 text-sky-200 text-xs flex items-center gap-1.5 cursor-pointer shrink-0">
                                      <ImagePlus className="w-3.5 h-3.5" />
                                      {t("上传图片", "Upload Image")}
                                      <input
                                        type="file"
                                        accept="image/*"
                                        className="hidden"
                                        onChange={(e) => {
                                          const f = e.target.files?.[0];
                                          if (f) handleUploadImageForNode(node.nid, key, f);
                                          e.target.value = "";
                                        }}
                                      />
                                    </label>
                                  </div>
                                </div>
                              </div>
                            );
                          }

                          // 5. Real ComfyUI Combo Dropdown (models, LoRAs, samplers, schedulers)
                          if (Array.isArray(choices) && choices.length > 0 && choices.length <= 500) {
                            const hasVal = choices.includes(strVal);
                            return (
                              <div key={key} className="space-y-1">
                                <span className="text-[11px] text-zinc-400 font-mono">{key}</span>
                                <select
                                  value={strVal}
                                  onChange={(e) => updateInput(node.nid, key, e.target.value)}
                                  className="w-full h-8 px-2 rounded-lg bg-[#0d1018] border border-zinc-700 focus:border-indigo-500 focus:outline-none text-xs font-mono text-zinc-100"
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

                          // 6. Multiline prompt / long text
                          const isMultiline =
                            MULTILINE_KEYS.has(kl) || strVal.includes("\n") || strVal.length > 55;
                          if (isMultiline) {
                            return (
                              <div key={key} className="md:col-span-2 space-y-1">
                                <span className="text-[11px] text-zinc-400 font-mono">{key}</span>
                                <textarea
                                  value={strVal}
                                  onFocus={() => setFocusedField({ nid: node.nid, key })}
                                  onChange={(e) => updateInput(node.nid, key, e.target.value)}
                                  rows={Math.max(4, Math.min(10, Math.ceil(strVal.length / 95)))}
                                  className="w-full p-3 rounded-lg bg-[#0c0f17] border border-zinc-700 focus:border-indigo-500 focus:outline-none text-[13px] text-zinc-100 leading-relaxed resize-y"
                                />
                              </div>
                            );
                          }

                          // 7. Short text input
                          return (
                            <div key={key} className="space-y-1">
                              <span className="text-[11px] text-zinc-400 font-mono">{key}</span>
                              <input
                                type="text"
                                value={strVal}
                                onChange={(e) => updateInput(node.nid, key, e.target.value)}
                                className="w-full h-8 px-2.5 rounded-lg bg-[#0d1018] border border-zinc-700 focus:border-indigo-500 focus:outline-none text-xs font-mono text-zinc-100"
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
        <div className="px-5 py-3 border-t border-zinc-800 bg-[#0d1018] flex flex-wrap items-center justify-between gap-3 shrink-0">
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
              <span className="text-zinc-400">{t("生成张数", "Batch Count")}</span>
              {[1, 2, 4].map((n) => (
                <button
                  key={n}
                  type="button"
                  onClick={() => setBatchCount(n)}
                  className={`px-2 py-0.5 rounded text-xs font-medium ${
                    batchCount === n ? "bg-indigo-600 text-white" : "bg-zinc-800 text-zinc-300"
                  }`}
                >
                  ×{n}
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <span className={`text-xs mr-2 ${comfyStatus.online ? "text-emerald-400" : "text-rose-400"}`}>
              {comfyStatus.online ? t("● ComfyUI 在线", "● ComfyUI Online") : t("● ComfyUI 离线", "● ComfyUI Offline")}
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
              disabled={!selectedPath || !promptJson || saving}
              onClick={handleSaveToWorkflow}
              title={t(
                "将当前修改的提示词与参数直接保存回工作流文件（不关闭弹窗）",
                "Save current prompt and parameter edits directly back to the workflow file (keeps modal open)"
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
    </div>
  );
};
