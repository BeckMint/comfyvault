import React, { useEffect, useState } from "react";
import { BookMarked, Check, Copy, Edit3, Plus, Search, Trash2, Wand2, X } from "lucide-react";
import { api } from "../api";
import { useI18n } from "../i18n";
import type { SnippetItem } from "../types";
import { PromptConverterModal, type WorkflowPrefillPayload } from "./PromptConverterModal";

interface Props {
  onToast: (msg: string, tone?: "ok" | "err") => void;
  onApplyConvertedPrompt?: (prefill: WorkflowPrefillPayload) => void;
}

const DEFAULT_CATS = ["正向", "人物外貌", "光影画质", "服装场景", "视频运镜", "负向", "精修", "通用"];

const CAT_LABELS: Record<string, { zh: string; en: string }> = {
  "全部": { zh: "全部", en: "All" },
  "正向": { zh: "正向", en: "Positive" },
  "人物外貌": { zh: "人物外貌", en: "Appearance" },
  "光影画质": { zh: "光影画质", en: "Lighting & Quality" },
  "服装场景": { zh: "服装场景", en: "Outfit & Scene" },
  "视频运镜": { zh: "视频运镜", en: "Camera Motion" },
  "负向": { zh: "负向", en: "Negative" },
  "精修": { zh: "精修", en: "Refine" },
  "通用": { zh: "通用", en: "General" },
};

export const SnippetsView: React.FC<Props> = ({ onToast, onApplyConvertedPrompt }) => {
  const { t } = useI18n();
  const catLabel = (c: string) => (CAT_LABELS[c] ? t(CAT_LABELS[c].zh, CAT_LABELS[c].en) : c);
  const [items, setItems] = useState<SnippetItem[]>([]);
  const [search, setSearch] = useState("");
  const [catFilter, setCatFilter] = useState("全部");
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const [converterSource, setConverterSource] = useState<string | null>(null);

  const [editing, setEditing] = useState<SnippetItem | null>(null);
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState("正向");
  const [content, setContent] = useState("");
  const [notes, setNotes] = useState("");

  const load = () => {
    api.listSnippets().then((r) => setItems(r.items));
  };

  useEffect(() => {
    load();
  }, []);

  const openCreate = () => {
    setEditing(null);
    setTitle("");
    setCategory("正向");
    setContent("");
    setNotes("");
    setCreating(true);
  };

  const openEdit = (item: SnippetItem) => {
    setEditing(item);
    setTitle(item.title);
    setCategory(item.category);
    setContent(item.content);
    setNotes(item.notes || "");
    setCreating(true);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !content.trim()) return;
    try {
      if (editing) {
        await api.updateSnippet(editing.id, { title, category, content, notes });
        onToast(t("提示词片段已更新", "Snippet updated"));
      } else {
        await api.createSnippet({ title, category, content, notes });
        onToast(t("已添加到提示词片段库", "Added to Prompt Snippets"));
      }
      setCreating(false);
      load();
    } catch (err: any) {
      onToast(err.message, "err");
    }
  };

  const handleDelete = async (id: number) => {
    await api.deleteSnippet(id);
    onToast(t("已删除片段", "Snippet deleted"));
    load();
  };

  const copy = async (item: SnippetItem) => {
    await navigator.clipboard.writeText(item.content);
    setCopiedId(item.id);
    setTimeout(() => setCopiedId(null), 1500);
    onToast(t("已复制提示词片段", "Snippet copied"));
  };

  const categories = ["全部", ...Array.from(new Set([...DEFAULT_CATS, ...items.map((i) => i.category)]))];

  const filtered = items.filter((i) => {
    if (catFilter !== "全部" && i.category !== catFilter) return false;
    if (search.trim()) {
      const q = search.toLowerCase();
      return (
        i.title.toLowerCase().includes(q) ||
        i.content.toLowerCase().includes(q) ||
        (i.notes || "").toLowerCase().includes(q)
      );
    }
    return true;
  });

  return (
    <div className="flex-1 h-full overflow-y-auto p-6 bg-[#0b0d12]">
      <div className="max-w-6xl mx-auto space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-lg font-bold text-white flex items-center gap-2">
              <BookMarked className="w-5 h-5 text-amber-400" />
              {t("常用提示词片段库", "Prompt Snippets & AI Converter")}
            </h1>
            <p className="text-xs text-zinc-400 mt-0.5">
              {t(
                "沉淀好用的外貌特征、光影词组、负向模板，并可通过 Gemini / ChatGPT 网页版一键转换为工作流结构化提示词",
                "Save reusable prompt fragments and convert any idea into structured workflow prompts via Gemini / ChatGPT web"
              )}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <div className="relative w-64">
              <Search className="w-3.5 h-3.5 text-zinc-500 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t("搜索片段...", "Search snippets...")}
                className="w-full h-9 pl-8 pr-3 rounded-lg bg-[#141722] border border-zinc-800 text-xs text-zinc-100 focus:outline-none focus:border-amber-500"
              />
            </div>
            <button
              type="button"
              onClick={() => setConverterSource("")}
              className="h-9 px-3.5 rounded-lg bg-amber-600/25 hover:bg-amber-600/40 border border-amber-500/45 text-xs font-semibold text-amber-200 flex items-center gap-1.5"
            >
              <Wand2 className="w-4 h-4 text-amber-400" /> {t("AI 转换提示词", "AI Prompt Converter")}
            </button>
            <button
              type="button"
              onClick={openCreate}
              className="h-9 px-3.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-xs font-semibold text-white flex items-center gap-1.5"
            >
              <Plus className="w-4 h-4" /> {t("新建片段", "New Snippet")}
            </button>
          </div>
        </div>

        {/* Category Pills */}
        <div className="flex flex-wrap gap-1.5">
          {categories.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setCatFilter(c)}
              className={`px-3 py-1 rounded-full text-xs border transition-colors ${
                catFilter === c
                  ? "bg-indigo-600 border-indigo-400 text-white"
                  : "bg-[#141722] border-zinc-800 text-zinc-400 hover:text-zinc-200"
              }`}
            >
              {catLabel(c)}
            </button>
          ))}
        </div>

        {/* Grid */}
        {filtered.length === 0 ? (
          <div className="py-16 text-center text-zinc-500 text-sm">
            {t(
              "暂无提示词片段，点击右上角“新建片段”或在图片详情页点击书签图标收藏",
              "No prompt snippets yet. Click \"New Snippet\" above or click the bookmark icon in an asset's detail view."
            )}
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {filtered.map((item) => (
              <div
                key={item.id}
                className="rounded-2xl bg-[#131722] border border-zinc-800/90 p-4 flex flex-col justify-between gap-3"
              >
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="px-2 py-0.5 rounded-md bg-amber-500/15 text-amber-300 border border-amber-500/30 text-[10px] shrink-0">
                        {catLabel(item.category)}
                      </span>
                      <span className="text-sm font-semibold text-zinc-100 truncate">{item.title}</span>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        type="button"
                        onClick={() => setConverterSource(item.content)}
                        title={t("用 Gemini / ChatGPT 转换此片段并填入工作流", "Convert this snippet with Gemini / ChatGPT and apply to workflow")}
                        className="px-2 py-1 rounded-md bg-amber-600/20 hover:bg-amber-600/35 border border-amber-500/30 text-[11px] text-amber-200 flex items-center gap-1"
                      >
                        <Wand2 className="w-3 h-3" />
                        {t("转换", "Convert")}
                      </button>
                      <button
                        type="button"
                        onClick={() => copy(item)}
                        className="px-2 py-1 rounded-md bg-zinc-800 hover:bg-indigo-600 text-[11px] text-zinc-200 flex items-center gap-1"
                      >
                        {copiedId === item.id ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                        {t("复制", "Copy")}
                      </button>
                      <button
                        type="button"
                        onClick={() => openEdit(item)}
                        className="p-1.5 rounded-md hover:bg-zinc-800 text-zinc-400 hover:text-zinc-100"
                      >
                        <Edit3 className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDelete(item.id)}
                        className="p-1.5 rounded-md hover:bg-zinc-800 text-zinc-400 hover:text-rose-400"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                  <pre className="p-3 rounded-xl bg-[#0c0f17] border border-zinc-800/80 text-xs text-zinc-200 whitespace-pre-wrap break-words font-sans max-h-40 overflow-y-auto select-text">
                    {item.content}
                  </pre>
                  {item.notes && <div className="text-[11px] text-zinc-400">{t("备注：", "Notes: ")}{item.notes}</div>}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* AI Prompt Converter Modal */}
      {converterSource !== null && (
        <PromptConverterModal
          initialSourceText={converterSource}
          onClose={() => setConverterSource(null)}
          onSavedSnippet={load}
          onToast={onToast}
          onApplyToWorkflow={(prefill) => {
            setConverterSource(null);
            onApplyConvertedPrompt?.(prefill);
          }}
        />
      )}

      {/* Create/Edit Modal */}
      {creating && (
        <div className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-4">
          <form
            onSubmit={handleSave}
            className="w-full max-w-lg rounded-2xl bg-[#131722] border border-zinc-700 p-5 space-y-4"
          >
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-white">{editing ? t("编辑提示词片段", "Edit Prompt Snippet") : t("新建提示词片段", "New Prompt Snippet")}</h2>
              <button type="button" onClick={() => setCreating(false)} className="text-zinc-400 hover:text-white">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <input
                required
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={t("片段标题", "Snippet title")}
                className="col-span-2 h-9 px-3 rounded-lg bg-[#0b0e16] border border-zinc-700 text-xs text-zinc-100 focus:outline-none focus:border-indigo-500"
              />
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="h-9 px-2 rounded-lg bg-[#0b0e16] border border-zinc-700 text-xs text-zinc-100"
              >
                {DEFAULT_CATS.map((c) => (
                  <option key={c} value={c}>
                    {catLabel(c)}
                  </option>
                ))}
              </select>
            </div>
            <textarea
              required
              rows={5}
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder={t("输入提示词内容...", "Enter prompt content...")}
              className="w-full p-3 rounded-lg bg-[#0b0e16] border border-zinc-700 text-xs text-zinc-100 focus:outline-none focus:border-indigo-500"
            />
            <input
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder={t("使用说明或适用底模（可选）", "Usage notes or compatible base model (optional)")}
              className="w-full h-9 px-3 rounded-lg bg-[#0b0e16] border border-zinc-700 text-xs text-zinc-100 focus:outline-none focus:border-indigo-500"
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setCreating(false)}
                className="px-4 py-1.5 rounded-lg bg-zinc-800 text-xs text-zinc-300"
              >
                {t("取消", "Cancel")}
              </button>
              <button type="submit" className="px-4 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-xs font-semibold text-white">
                {t("保存", "Save")}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};
