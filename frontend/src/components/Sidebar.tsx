import React, { useEffect, useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Cpu,
  Edit3,
  Film,
  Folder,
  FolderOpen,
  FolderSearch,
  GitBranch,
  Image as ImageIcon,
  Layers,
  LayoutGrid,
  RefreshCw,
  Sparkles,
  Star,
  Tag,
  ThumbsDown,
  ThumbsUp,
  Trash2,
  X,
} from "lucide-react";
import type { AssetFilter, SidebarFacets } from "../types";
import { useI18n } from "../i18n";

interface Props {
  facets: SidebarFacets | null;
  filter: AssetFilter;
  onFilterChange: (patch: Partial<AssetFilter>) => void;
  onFolderReveal: (folder: string) => void;
  onFolderRename: (folder: string, currentName: string) => void;
  onFolderDelete: (folder: string, count: number) => void;
  onTriggerScan: () => void;
}

interface FolderTreeNode {
  name: string;
  fullPath: string;
  directCount: number;
  totalCount: number;
  children: FolderTreeNode[];
}

function buildFolderTree(folders: Array<{ folder: string; count: number }>): FolderTreeNode[] {
  const rootMap = new Map<string, FolderTreeNode>();

  const ensureNode = (fullPath: string, name: string): FolderTreeNode => {
    let node = rootMap.get(fullPath);
    if (!node) {
      node = { name, fullPath, directCount: 0, totalCount: 0, children: [] };
      rootMap.set(fullPath, node);
    }
    return node;
  };

  for (const item of folders) {
    if (!item.folder) continue;
    const parts = item.folder.split("/").filter(Boolean);
    let acc = "";
    let parent: FolderTreeNode | null = null;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      acc = acc ? `${acc}/${part}` : part;
      const node = ensureNode(acc, part);
      node.totalCount += item.count;
      if (i === parts.length - 1) {
        node.directCount += item.count;
      }
      if (parent && !parent.children.includes(node)) {
        parent.children.push(node);
      }
      parent = node;
    }
  }

  const tops: FolderTreeNode[] = [];
  for (const [k, node] of rootMap.entries()) {
    if (!k.includes("/")) {
      tops.push(node);
    }
  }

  const sortRec = (arr: FolderTreeNode[]) => {
    arr.sort((a, b) => b.name.localeCompare(a.name));
    arr.forEach((n) => sortRec(n.children));
  };
  sortRec(tops);
  return tops;
}

export const Sidebar: React.FC<Props> = ({
  facets,
  filter,
  onFilterChange,
  onFolderReveal,
  onFolderRename,
  onFolderDelete,
  onTriggerScan,
}) => {
  const { t } = useI18n();
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; folder: string; name: string; count: number } | null>(
    null
  );

  useEffect(() => {
    if (!ctxMenu) return;
    const close = () => setCtxMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("scroll", close, true);
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("keydown", close);
    };
  }, [ctxMenu]);
  const [openSections, setOpenSections] = useState({
    folders: true,
    families: true,
    loras: true,
    models: false,
    workflows: false,
    versions: false,
    tags: true,
  });

  const folderTree = useMemo(() => buildFolderTree(facets?.folders || []), [facets?.folders]);
  const rootDirectCount = useMemo(
    () => facets?.folders.find((f) => f.folder === "")?.count || 0,
    [facets?.folders]
  );

  // Pin active selection to the very top of each filter list
  const sortedFamilies = useMemo(() => {
    const list = facets?.model_families || [];
    if (!filter.modelFamily) return list;
    return [...list].sort((a, b) => (a.name === filter.modelFamily ? -1 : b.name === filter.modelFamily ? 1 : 0));
  }, [facets?.model_families, filter.modelFamily]);

  const sortedLoras = useMemo(() => {
    const list = facets?.loras || [];
    if (!filter.lora) return list;
    return [...list].sort((a, b) => (a.name === filter.lora ? -1 : b.name === filter.lora ? 1 : 0));
  }, [facets?.loras, filter.lora]);

  const sortedModels = useMemo(() => {
    const list = facets?.models || [];
    if (!filter.baseModel) return list;
    return [...list].sort((a, b) => (a.name === filter.baseModel ? -1 : b.name === filter.baseModel ? 1 : 0));
  }, [facets?.models, filter.baseModel]);

  const sortedWorkflows = useMemo(() => {
    const list = facets?.workflows || [];
    if (!filter.workflowHash) return list;
    return [...list].sort((a, b) => (a.hash === filter.workflowHash ? -1 : b.hash === filter.workflowHash ? 1 : 0));
  }, [facets?.workflows, filter.workflowHash]);

  const sortedVersions = useMemo(() => {
    const list = facets?.versions || [];
    if (!filter.comfyVersion) return list;
    return [...list].sort((a, b) => (a.version === filter.comfyVersion ? -1 : b.version === filter.comfyVersion ? 1 : 0));
  }, [facets?.versions, filter.comfyVersion]);

  const sortedTags = useMemo(() => {
    const list = facets?.tags || [];
    if (filter.tagId === null) return list;
    return [...list].sort((a, b) => (a.id === filter.tagId ? -1 : b.id === filter.tagId ? 1 : 0));
  }, [facets?.tags, filter.tagId]);

  const selectedBadge = (count: number, onClear: () => void) =>
    count > 0 ? (
      <span
        onClick={(e) => {
          e.stopPropagation();
          onClear();
        }}
        title="点击清除此项筛选"
        className="ml-1 inline-flex items-center gap-0.5 px-1.5 py-0.2 rounded-full bg-indigo-600 text-white text-[10px] font-medium normal-case tracking-normal hover:bg-rose-500 transition-colors shrink-0"
      >
        已选 {count}
        <X className="w-2.5 h-2.5" />
      </span>
    ) : null;

  const toggleFolder = (path: string) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const toggleSection = (key: keyof typeof openSections) => {
    setOpenSections((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const renderFolderNode = (node: FolderTreeNode, depth = 0) => {
    const isExp = expandedFolders.has(node.fullPath);
    const isActive = !filter.showDeleted && filter.folder === node.fullPath;
    const hasKids = node.children.length > 0;

    return (
      <div key={node.fullPath}>
        <div
          className={`flex items-center gap-1 py-1 pr-2 rounded-md cursor-pointer text-xs transition-colors ${
            isActive ? "bg-indigo-600/25 text-indigo-200 font-medium" : "text-zinc-300 hover:bg-zinc-800/70"
          }`}
          style={{ paddingLeft: 8 + depth * 14 }}
          onClick={() =>
            onFilterChange({
              folder: node.fullPath,
              folderExact: false,
              showDeleted: false,
            })
          }
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setCtxMenu({
              x: Math.min(e.clientX, window.innerWidth - 200),
              y: Math.min(e.clientY, window.innerHeight - 180),
              folder: node.fullPath,
              name: node.name,
              count: node.totalCount,
            });
          }}
        >
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              if (hasKids) toggleFolder(node.fullPath);
            }}
            className={`w-4 h-4 flex items-center justify-center shrink-0 ${
              hasKids ? "text-zinc-400 hover:text-white" : "opacity-0 pointer-events-none"
            }`}
          >
            {isExp ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
          </button>
          {isActive || isExp ? (
            <FolderOpen className="w-3.5 h-3.5 text-amber-400/90 shrink-0" />
          ) : (
            <Folder className="w-3.5 h-3.5 text-amber-400/70 shrink-0" />
          )}
          <span className="truncate flex-1" title={node.fullPath}>
            {node.name}
          </span>
          <span className="text-[10px] text-zinc-500 font-mono">{node.totalCount}</span>
        </div>
        {hasKids && isExp && <div>{node.children.map((c) => renderFolderNode(c, depth + 1))}</div>}
      </div>
    );
  };

  const c = facets?.counts;

  const navBtn = (
    active: boolean,
    icon: React.ReactNode,
    label: string,
    count: number | undefined,
    onClick: () => void
  ) => (
    <button
      type="button"
      onClick={onClick}
      className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs transition-colors ${
        active ? "bg-indigo-600/25 text-indigo-200 font-medium" : "text-zinc-300 hover:bg-zinc-800/70"
      }`}
    >
      {icon}
      <span className="flex-1 text-left truncate">{label}</span>
      {count !== undefined && <span className="text-[10px] text-zinc-500 font-mono">{count}</span>}
    </button>
  );

  return (
    <aside className="w-64 shrink-0 h-full bg-[#0f121a] border-r border-zinc-800/90 flex flex-col overflow-y-auto select-none">
      {/* Quick Smart Views */}
      <div className="p-2.5 space-y-0.5 border-b border-zinc-800/80">
        {navBtn(
          !filter.showDeleted &&
            filter.folder === "__ALL__" &&
            !filter.mediaType &&
            !filter.flag &&
            filter.minRating === 0 &&
            !filter.lora &&
            !filter.modelFamily &&
            !filter.baseModel &&
            !filter.workflowHash &&
            !filter.recipeHash &&
            filter.tagId === null,
          <LayoutGrid className="w-3.5 h-3.5 text-indigo-400" />,
          t("全部资源", "All Assets"),
          c?.total,
          () =>
            onFilterChange({
              folder: "__ALL__",
              folderExact: false,
              mediaType: "",
              flag: "",
              minRating: 0,
              lora: "",
              modelFamily: "",
              baseModel: "",
              workflowHash: "",
              recipeHash: "",
              tagId: null,
              comfyVersion: "",
              showDeleted: false,
            })
        )}
        {navBtn(
          !filter.showDeleted && filter.mediaType === "image",
          <ImageIcon className="w-3.5 h-3.5 text-sky-400" />,
          t("全部图片", "Images"),
          c?.images,
          () => onFilterChange({ mediaType: filter.mediaType === "image" ? "" : "image", showDeleted: false })
        )}
        {navBtn(
          !filter.showDeleted && filter.mediaType === "video",
          <Film className="w-3.5 h-3.5 text-purple-400" />,
          t("全部视频", "Videos"),
          c?.videos,
          () => onFilterChange({ mediaType: filter.mediaType === "video" ? "" : "video", showDeleted: false })
        )}
        {navBtn(
          !filter.showDeleted && filter.minRating >= 4,
          <Star className="w-3.5 h-3.5 text-amber-400" />,
          t("高星作品 (≥4★)", "Top Rated (≥4★)"),
          c?.starred,
          () => onFilterChange({ minRating: filter.minRating >= 4 ? 0 : 4, showDeleted: false })
        )}
        {navBtn(
          !filter.showDeleted && filter.flag === "pick",
          <ThumbsUp className="w-3.5 h-3.5 text-emerald-400" />,
          t("精选标记", "Picked"),
          c?.picked,
          () => onFilterChange({ flag: filter.flag === "pick" ? "" : "pick", showDeleted: false })
        )}
        {navBtn(
          !filter.showDeleted && filter.flag === "reject",
          <ThumbsDown className="w-3.5 h-3.5 text-rose-400" />,
          t("废片标记", "Rejected"),
          c?.rejected,
          () => onFilterChange({ flag: filter.flag === "reject" ? "" : "reject", showDeleted: false })
        )}
        {navBtn(
          filter.showDeleted,
          <Trash2 className="w-3.5 h-3.5 text-zinc-400" />,
          t("回收站", "Trash"),
          c?.trash,
          () => onFilterChange({ showDeleted: !filter.showDeleted })
        )}
      </div>

      {/* Physical Directory Tree */}
      <div className="p-2.5 border-b border-zinc-800/80">
        <button
          type="button"
          onClick={() => toggleSection("folders")}
          className="w-full flex items-center justify-between text-[11px] font-semibold uppercase tracking-wider text-zinc-400 hover:text-zinc-200 mb-1.5 px-1"
        >
          <span className="flex items-center gap-1 min-w-0">
            <span className="truncate">{t("目录管理器 (相册/output)", "Folders (Gallery / Output)")}</span>
            {selectedBadge(!filter.showDeleted && filter.folder !== "__ALL__" ? 1 : 0, () =>
              onFilterChange({ folder: "__ALL__", folderExact: false })
            )}
          </span>
          {openSections.folders ? <ChevronDown className="w-3.5 h-3.5 shrink-0" /> : <ChevronRight className="w-3.5 h-3.5 shrink-0" />}
        </button>
        {openSections.folders && (
          <div className="space-y-0.5 max-h-64 overflow-y-auto pr-0.5">
            {!filter.showDeleted && filter.folder !== "__ALL__" && filter.folder !== "" && (
              <div className="flex items-center gap-1.5 py-1 px-2 mb-1 rounded-md bg-indigo-600/25 border border-indigo-500/40 text-indigo-200 text-xs">
                <FolderOpen className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                <span className="flex-1 truncate font-medium" title={filter.folder}>
                  {filter.folder}
                </span>
                <button
                  type="button"
                  onClick={() => onFilterChange({ folder: "__ALL__", folderExact: false })}
                  className="text-indigo-200 hover:text-rose-400 shrink-0"
                  title="取消目录筛选"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            )}
            {rootDirectCount > 0 && (
              <div
                onClick={() => onFilterChange({ folder: "", folderExact: true, showDeleted: false })}
                className={`flex items-center gap-1.5 py-1 px-2 rounded-md cursor-pointer text-xs ${
                  filter.folder === "" && filter.folderExact
                    ? "bg-indigo-600/25 text-indigo-200"
                    : "text-zinc-300 hover:bg-zinc-800/70"
                }`}
              >
                <Folder className="w-3.5 h-3.5 text-zinc-400" />
                <span className="flex-1 truncate">output 根目录</span>
                <span className="text-[10px] text-zinc-500 font-mono">{rootDirectCount}</span>
              </div>
            )}
            {folderTree.map((n) => renderFolderNode(n))}
          </div>
        )}
      </div>

      {/* Foundation Generation Model Family Facet */}
      <div className="p-2.5 border-b border-zinc-800/80">
        <button
          type="button"
          onClick={() => toggleSection("families")}
          className="w-full flex items-center justify-between text-[11px] font-semibold uppercase tracking-wider text-zinc-400 hover:text-zinc-200 mb-1.5 px-1"
        >
          <span className="flex items-center gap-1.5 min-w-0">
            <Cpu className="w-3 h-3 text-cyan-400 shrink-0" />
            <span className="truncate">模型 ({facets?.model_families?.length || 0})</span>
            {selectedBadge(filter.modelFamily ? 1 : 0, () => onFilterChange({ modelFamily: "" }))}
          </span>
          {openSections.families ? <ChevronDown className="w-3.5 h-3.5 shrink-0" /> : <ChevronRight className="w-3.5 h-3.5 shrink-0" />}
        </button>
        {openSections.families && (
          <div className="space-y-0.5 max-h-48 overflow-y-auto">
            {sortedFamilies.map((f) => {
              const active = filter.modelFamily === f.name;
              return (
                <button
                  key={f.name}
                  type="button"
                  onClick={() => onFilterChange({ modelFamily: active ? "" : f.name, showDeleted: false })}
                  className={`w-full flex items-center justify-between gap-2 px-2 py-1 rounded text-xs transition-colors ${
                    active ? "bg-cyan-600/30 text-cyan-200 font-medium border border-cyan-500/40" : "text-zinc-300 hover:bg-zinc-800/70"
                  }`}
                >
                  <span className="truncate">{f.name}</span>
                  <span className="text-[10px] text-zinc-500 font-mono shrink-0">{f.count}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* LoRAs Facet */}
      <div className="p-2.5 border-b border-zinc-800/80">
        <button
          type="button"
          onClick={() => toggleSection("loras")}
          className="w-full flex items-center justify-between text-[11px] font-semibold uppercase tracking-wider text-zinc-400 hover:text-zinc-200 mb-1.5 px-1"
        >
          <span className="flex items-center gap-1.5 min-w-0">
            <Sparkles className="w-3 h-3 text-purple-400 shrink-0" />
            <span className="truncate">LoRA 筛选 ({facets?.loras.length || 0})</span>
            {selectedBadge(filter.lora ? 1 : 0, () => onFilterChange({ lora: "" }))}
          </span>
          {openSections.loras ? <ChevronDown className="w-3.5 h-3.5 shrink-0" /> : <ChevronRight className="w-3.5 h-3.5 shrink-0" />}
        </button>
        {openSections.loras && (
          <div className="space-y-0.5 max-h-48 overflow-y-auto">
            {sortedLoras.map((l) => {
              const short = l.name.split("/").pop() || l.name;
              const active = filter.lora === l.name;
              return (
                <button
                  key={l.name}
                  type="button"
                  title={l.name}
                  onClick={() => onFilterChange({ lora: active ? "" : l.name, showDeleted: false })}
                  className={`w-full flex items-center justify-between gap-2 px-2 py-1 rounded text-xs transition-colors ${
                    active ? "bg-purple-600/30 text-purple-200 font-medium border border-purple-500/40" : "text-zinc-300 hover:bg-zinc-800/70"
                  }`}
                >
                  <span className="truncate">{short}</span>
                  <span className="text-[10px] text-zinc-500 font-mono shrink-0">{l.count}</span>
                </button>
              );
            })}
            {facets && facets.loras.length === 0 && (
              <div className="text-[11px] text-zinc-500 px-2 py-1">暂未检测到 LoRA</div>
            )}
          </div>
        )}
      </div>

      {/* Base Models Facet */}
      <div className="p-2.5 border-b border-zinc-800/80">
        <button
          type="button"
          onClick={() => toggleSection("models")}
          className="w-full flex items-center justify-between text-[11px] font-semibold uppercase tracking-wider text-zinc-400 hover:text-zinc-200 mb-1.5 px-1"
        >
          <span className="flex items-center gap-1.5 min-w-0">
            <Cpu className="w-3 h-3 text-sky-400 shrink-0" />
            <span className="truncate">底模 / UNET ({facets?.models.length || 0})</span>
            {selectedBadge(filter.baseModel ? 1 : 0, () => onFilterChange({ baseModel: "" }))}
          </span>
          {openSections.models ? <ChevronDown className="w-3.5 h-3.5 shrink-0" /> : <ChevronRight className="w-3.5 h-3.5 shrink-0" />}
        </button>
        {openSections.models && (
          <div className="space-y-0.5 max-h-44 overflow-y-auto">
            {sortedModels.map((m) => {
              const short = m.name.split("/").pop() || m.name;
              const active = filter.baseModel === m.name;
              return (
                <button
                  key={m.name}
                  type="button"
                  title={m.name}
                  onClick={() => onFilterChange({ baseModel: active ? "" : m.name, showDeleted: false })}
                  className={`w-full flex items-center justify-between gap-2 px-2 py-1 rounded text-xs ${
                    active ? "bg-sky-600/30 text-sky-200 font-medium border border-sky-500/40" : "text-zinc-300 hover:bg-zinc-800/70"
                  }`}
                >
                  <span className="truncate">{short}</span>
                  <span className="text-[10px] text-zinc-500 font-mono shrink-0">{m.count}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Workflows Facet */}
      <div className="p-2.5 border-b border-zinc-800/80">
        <button
          type="button"
          onClick={() => toggleSection("workflows")}
          className="w-full flex items-center justify-between text-[11px] font-semibold uppercase tracking-wider text-zinc-400 hover:text-zinc-200 mb-1.5 px-1"
        >
          <span className="flex items-center gap-1.5 min-w-0">
            <Layers className="w-3 h-3 text-emerald-400 shrink-0" />
            <span className="truncate">工作流指纹 ({facets?.workflows.length || 0})</span>
            {selectedBadge(filter.workflowHash ? 1 : 0, () => onFilterChange({ workflowHash: "" }))}
          </span>
          {openSections.workflows ? <ChevronDown className="w-3.5 h-3.5 shrink-0" /> : <ChevronRight className="w-3.5 h-3.5 shrink-0" />}
        </button>
        {openSections.workflows && (
          <div className="space-y-0.5 max-h-44 overflow-y-auto">
            {sortedWorkflows.map((w) => {
              const active = filter.workflowHash === w.hash;
              return (
                <button
                  key={w.hash}
                  type="button"
                  onClick={() => onFilterChange({ workflowHash: active ? "" : w.hash, showDeleted: false })}
                  className={`w-full flex items-center justify-between gap-2 px-2 py-1 rounded text-xs ${
                    active ? "bg-emerald-600/30 text-emerald-200 font-medium border border-emerald-500/40" : "text-zinc-300 hover:bg-zinc-800/70"
                  }`}
                >
                  <span className="truncate">
                    {w.name} <span className="text-[10px] text-zinc-500">#{w.hash.slice(0, 6)}</span>
                  </span>
                  <span className="text-[10px] text-zinc-500 font-mono shrink-0">{w.count}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* ComfyUI Versions */}
      {(facets?.versions?.length || 0) > 0 && (
        <div className="p-2.5 border-b border-zinc-800/80">
          <button
            type="button"
            onClick={() => toggleSection("versions")}
            className="w-full flex items-center justify-between text-[11px] font-semibold uppercase tracking-wider text-zinc-400 hover:text-zinc-200 mb-1.5 px-1"
          >
            <span className="flex items-center gap-1.5 min-w-0">
              <GitBranch className="w-3 h-3 text-amber-400 shrink-0" />
              <span className="truncate">ComfyUI 版本</span>
              {selectedBadge(filter.comfyVersion ? 1 : 0, () => onFilterChange({ comfyVersion: "" }))}
            </span>
            {openSections.versions ? <ChevronDown className="w-3.5 h-3.5 shrink-0" /> : <ChevronRight className="w-3.5 h-3.5 shrink-0" />}
          </button>
          {openSections.versions && (
            <div className="space-y-0.5">
              {sortedVersions.map((v) => {
                const active = filter.comfyVersion === v.version;
                return (
                  <button
                    key={v.version}
                    type="button"
                    onClick={() => onFilterChange({ comfyVersion: active ? "" : v.version, showDeleted: false })}
                    className={`w-full flex items-center justify-between gap-2 px-2 py-1 rounded text-xs ${
                      active ? "bg-amber-600/30 text-amber-200 font-medium border border-amber-500/40" : "text-zinc-300 hover:bg-zinc-800/70"
                    }`}
                  >
                    <span className="truncate font-mono text-[11px]">{v.version}</span>
                    <span className="text-[10px] text-zinc-500 font-mono">{v.count}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Custom Tags */}
      <div className="p-2.5">
        <button
          type="button"
          onClick={() => toggleSection("tags")}
          className="w-full flex items-center justify-between text-[11px] font-semibold uppercase tracking-wider text-zinc-400 hover:text-zinc-200 mb-1.5 px-1"
        >
          <span className="flex items-center gap-1.5 min-w-0">
            <Tag className="w-3 h-3 text-pink-400 shrink-0" />
            <span className="truncate">自定义标签 ({facets?.tags.length || 0})</span>
            {selectedBadge(filter.tagId !== null ? 1 : 0, () => onFilterChange({ tagId: null }))}
          </span>
          {openSections.tags ? <ChevronDown className="w-3.5 h-3.5 shrink-0" /> : <ChevronRight className="w-3.5 h-3.5 shrink-0" />}
        </button>
        {openSections.tags && (
          <div className="flex flex-wrap gap-1.5 pt-0.5">
            {sortedTags.map((t) => {
              const active = filter.tagId === t.id;
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => onFilterChange({ tagId: active ? null : t.id, showDeleted: false })}
                  className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] border transition-colors ${
                    active
                      ? "bg-indigo-600 border-indigo-400 text-white"
                      : "bg-zinc-900 border-zinc-700 text-zinc-300 hover:border-zinc-500"
                  }`}
                >
                  <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: t.color }} />
                  {t.name}
                  <span className="text-[10px] opacity-60">{t.count}</span>
                </button>
              );
            })}
            {facets && facets.tags.length === 0 && (
              <span className="text-[11px] text-zinc-500 px-1">在右侧详情页添加标签</span>
            )}
          </div>
        )}
      </div>

      {/* Folder Right-Click Context Menu */}
      {ctxMenu && (
        <div
          onClick={(e) => e.stopPropagation()}
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
          className="fixed z-[80] w-48 py-1.5 rounded-xl bg-[#161b28] border border-zinc-700/90 shadow-2xl text-xs text-zinc-200"
        >
          <div className="px-3 py-1 text-[10px] text-zinc-500 truncate border-b border-zinc-800 mb-1" title={ctxMenu.folder}>
            {ctxMenu.folder}
          </div>
          <button
            type="button"
            onClick={() => {
              const f = ctxMenu.folder;
              setCtxMenu(null);
              onFolderReveal(f);
            }}
            className="w-full px-3 py-1.5 hover:bg-zinc-800 flex items-center gap-2 text-left"
          >
            <FolderSearch className="w-3.5 h-3.5 text-amber-400" />
            在资源管理器中打开
          </button>
          <button
            type="button"
            onClick={() => {
              const { folder, name } = ctxMenu;
              setCtxMenu(null);
              onFolderRename(folder, name);
            }}
            className="w-full px-3 py-1.5 hover:bg-zinc-800 flex items-center gap-2 text-left"
          >
            <Edit3 className="w-3.5 h-3.5 text-sky-400" />
            重命名文件夹
          </button>
          <button
            type="button"
            onClick={() => {
              setCtxMenu(null);
              onTriggerScan();
            }}
            className="w-full px-3 py-1.5 hover:bg-zinc-800 flex items-center gap-2 text-left"
          >
            <RefreshCw className="w-3.5 h-3.5 text-indigo-400" />
            重新扫描目录
          </button>
          <div className="my-1 border-t border-zinc-800" />
          <button
            type="button"
            onClick={() => {
              const { folder, count } = ctxMenu;
              setCtxMenu(null);
              onFolderDelete(folder, count);
            }}
            className="w-full px-3 py-1.5 hover:bg-rose-600/25 text-rose-300 flex items-center gap-2 text-left"
          >
            <Trash2 className="w-3.5 h-3.5" />
            删除文件夹（移入回收站）
          </button>
        </div>
      )}
    </aside>
  );
};
