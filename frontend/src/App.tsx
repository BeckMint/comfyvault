import React, { useCallback, useEffect, useRef, useState } from "react";
import { GitCompare, RotateCcw, Trash2, X } from "lucide-react";
import { api } from "./api";
import { AssetDetailDrawer } from "./components/AssetDetailDrawer";
import { CompareModal } from "./components/CompareModal";
import { FolderSummaryPanel } from "./components/FolderSummaryPanel";
import { LightboxModal } from "./components/LightboxModal";
import { LiveProgressBar } from "./components/LiveProgressBar";
import { LoraMatrixView } from "./components/LoraMatrixView";
import { RemixModal } from "./components/RemixModal";
import { SettingsModal } from "./components/SettingsModal";
import { Sidebar } from "./components/Sidebar";
import { SnippetsView } from "./components/SnippetsView";
import { TopBar, type ActiveTab } from "./components/TopBar";
import { VirtualMasonry } from "./components/VirtualMasonry";
import { WorkflowCreateModal } from "./components/WorkflowCreateModal";
import type { WorkflowPrefillPayload } from "./components/PromptConverterModal";
import type {
  AssetDetail,
  AssetFilter,
  AssetListItem,
  ComfyStatus,
  ScanStatus,
  SidebarFacets,
  ThumbStatus,
} from "./types";

const INITIAL_FILTER: AssetFilter = {
  folder: "__ALL__",
  folderExact: false,
  mediaType: "",
  search: "",
  lora: "",
  modelFamily: "",
  baseModel: "",
  workflowHash: "",
  recipeHash: "",
  tagId: null,
  minRating: 0,
  flag: "",
  comfyVersion: "",
  showDeleted: false,
  collapseRecipes: false,
  sort: "newest",
};

const PAGE_SIZE = 250;

export default function App() {
  const [activeTab, setActiveTab] = useState<ActiveTab>("gallery");
  const [filter, setFilter] = useState<AssetFilter>(INITIAL_FILTER);
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [cardMinWidth, setCardMinWidth] = useState(220);

  const [facets, setFacets] = useState<SidebarFacets | null>(null);
  const [items, setItems] = useState<AssetListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [checkedIds, setCheckedIds] = useState<Set<number>>(new Set());
  const [remixDetail, setRemixDetail] = useState<AssetDetail | null>(null);
  const [compareIds, setCompareIds] = useState<[number, number] | null>(null);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [showWorkflowCreate, setShowWorkflowCreate] = useState(false);
  const [workflowPrefill, setWorkflowPrefill] = useState<WorkflowPrefillPayload | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [detailRefreshTick, setDetailRefreshTick] = useState(0);

  const [comfyStatus, setComfyStatus] = useState<ComfyStatus>({
    online: false,
    comfy_url: "http://127.0.0.1:8188",
    comfy_version: "",
    queue_remaining: 0,
    executing_prompt_id: null,
    executing_node: null,
    progress_value: 0,
    progress_max: 0,
  });
  const [scanStatus, setScanStatus] = useState<ScanStatus>({
    scanning: false,
    scanned: 0,
    total: 0,
    added: 0,
    last_scan_at: 0,
  });
  const [thumbStatus, setThumbStatus] = useState<ThumbStatus>({
    running: false,
    done: 0,
    total: 0,
  });

  const [toast, setToast] = useState<{ msg: string; tone: "ok" | "err" } | null>(null);
  const toastTimer = useRef<number | null>(null);

  const showToast = useCallback((msg: string, tone: "ok" | "err" = "ok") => {
    setToast({ msg, tone });
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 3200);
  }, []);

  // Debounce search text
  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedSearch(filter.search), 220);
    return () => window.clearTimeout(t);
  }, [filter.search]);

  const effectiveFilter = React.useMemo(
    () => ({ ...filter, search: debouncedSearch }),
    [filter, debouncedSearch]
  );

  const loadFacets = useCallback(() => {
    api.getFacets().then(setFacets).catch(() => {});
  }, []);

  const loadAssets = useCallback(
    async (reset = true) => {
      setLoading(true);
      try {
        const offset = reset ? 0 : items.length;
        const res = await api.listAssets(effectiveFilter, PAGE_SIZE, offset);
        setTotal(res.total);
        setItems((prev) => (reset ? res.items : [...prev, ...res.items]));
      } catch (e: any) {
        showToast(`加载资源失败: ${e.message}`, "err");
      } finally {
        setLoading(false);
      }
    },
    [effectiveFilter, items.length, showToast]
  );

  // Reload whenever filters change
  useEffect(() => {
    loadAssets(true);
  }, [effectiveFilter]);

  useEffect(() => {
    loadFacets();
  }, [loadFacets]);

  const loadAssetsRef = useRef(loadAssets);
  loadAssetsRef.current = loadAssets;
  const loadFacetsRef = useRef(loadFacets);
  loadFacetsRef.current = loadFacets;

  // Live WebSocket connection to backend (connects ONCE, never reconnects on filter/items change!)
  useEffect(() => {
    let ws: WebSocket | null = null;
    let reconnectTimer: number | null = null;
    let alive = true;

    const connect = () => {
      if (!alive) return;
      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      ws = new WebSocket(`${proto}//${window.location.host}/ws`);

      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === "init") {
            if (msg.data.comfy_status) setComfyStatus(msg.data.comfy_status);
            if (msg.data.scan_status) setScanStatus(msg.data.scan_status);
            if (msg.data.thumb_status) setThumbStatus(msg.data.thumb_status);
          } else if (msg.type === "comfy_status") {
            setComfyStatus(msg.data);
          } else if (msg.type === "scan_progress") {
            setScanStatus(msg.data);
          } else if (msg.type === "thumb_progress") {
            setThumbStatus(msg.data);
          } else if (msg.type === "thumb_done") {
            setThumbStatus(msg.data);
            showToast("全部历史缩略图已后台预生成并永久缓存");
          } else if (msg.type === "scan_done") {
            setScanStatus(msg.data);
            loadFacetsRef.current();
            loadAssetsRef.current(true);
            if (msg.data.added > 0) {
              showToast(`目录扫描完成：新增/更新 ${msg.data.added} 项资源`);
            }
          } else if (msg.type === "generation_captured" || msg.type === "asset_indexed") {
            loadFacetsRef.current();
            loadAssetsRef.current(true);
            if (msg.type === "generation_captured") {
              showToast("新生成资源已自动捕获并入库！");
            }
          }
        } catch {
          // ignore
        }
      };

      ws.onclose = () => {
        if (alive) {
          reconnectTimer = window.setTimeout(connect, 2500);
        }
      };
    };

    connect();
    return () => {
      alive = false;
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      if (ws) ws.close();
    };
  }, [showToast]);

  const handleFilterChange = useCallback((patch: Partial<AssetFilter>) => {
    setFilter((prev) => ({ ...prev, ...patch }));
  }, []);

  const handleResetFilters = useCallback(() => {
    setFilter(INITIAL_FILTER);
  }, []);

  const handleToggleCheck = useCallback((id: number) => {
    setCheckedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleQuickRate = useCallback(
    async (id: number, rating: number) => {
      setItems((prev) => prev.map((it) => (it.id === id ? { ...it, rating } : it)));
      await api.patchAsset(id, { rating });
      loadFacets();
    },
    [loadFacets]
  );

  const handleQuickFlag = useCallback(
    async (id: number, flag: "" | "pick" | "reject") => {
      setItems((prev) => prev.map((it) => (it.id === id ? { ...it, flag } : it)));
      await api.patchAsset(id, { flag });
      loadFacets();
    },
    [loadFacets]
  );

  // Lightroom-style keyboard shortcuts when an asset is selected
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (remixDetail || compareIds || lightboxIndex !== null || showWorkflowCreate) return;
      if (e.key === "Escape" && checkedIds.size > 0) {
        setCheckedIds(new Set());
        return;
      }
      if (selectedId === null) return;

      if (e.key === "Escape") {
        setSelectedId(null);
      } else if (e.key >= "1" && e.key <= "5") {
        handleQuickRate(selectedId, Number(e.key));
      } else if (e.key.toLowerCase() === "p") {
        const cur = items.find((i) => i.id === selectedId);
        handleQuickFlag(selectedId, cur?.flag === "pick" ? "" : "pick");
      } else if (e.key.toLowerCase() === "x") {
        const cur = items.find((i) => i.id === selectedId);
        handleQuickFlag(selectedId, cur?.flag === "reject" ? "" : "reject");
      } else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        const idx = items.findIndex((i) => i.id === selectedId);
        if (idx >= 0) {
          const nextIdx = e.key === "ArrowRight" ? idx + 1 : idx - 1;
          if (nextIdx >= 0 && nextIdx < items.length) {
            setSelectedId(items[nextIdx].id);
          }
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectedId, items, checkedIds, remixDetail, compareIds, lightboxIndex, showWorkflowCreate, handleQuickRate, handleQuickFlag]);

  const checkedList = Array.from(checkedIds);

  const handleBatchTrash = async () => {
    if (!checkedList.length) return;
    await api.batchTrash(checkedList, true);
    setCheckedIds(new Set());
    loadFacets();
    loadAssets(true);
    showToast(`已将 ${checkedList.length} 项移入回收站`);
  };

  const handleBatchRestore = async () => {
    if (!checkedList.length) return;
    await api.batchTrash(checkedList, false);
    setCheckedIds(new Set());
    loadFacets();
    loadAssets(true);
    showToast(`已恢复 ${checkedList.length} 项资源`);
  };

  const handleBatchPurge = async () => {
    if (!checkedList.length) return;
    if (!window.confirm(`确认将这 ${checkedList.length} 项从数据库移除并将文件移入 Windows 回收站吗？`)) return;
    const res = await api.purgeAssets(checkedList, true);
    setCheckedIds(new Set());
    if (selectedId && checkedIds.has(selectedId)) setSelectedId(null);
    loadFacets();
    loadAssets(true);
    showToast(`已清理 ${res.purged} 条记录（磁盘移入回收站 ${res.deleted_files} 个文件）`);
  };

  const handleTriggerScan = async () => {
    await api.triggerScan(false);
    showToast("已启动后台增量扫描...");
  };

  return (
    <div className="h-screen w-screen flex flex-col bg-[#0b0d12] text-zinc-100 overflow-hidden">
      <TopBar
        activeTab={activeTab}
        onTabChange={setActiveTab}
        filter={filter}
        onFilterChange={handleFilterChange}
        onResetFilters={handleResetFilters}
        cardMinWidth={cardMinWidth}
        onCardMinWidthChange={setCardMinWidth}
        total={total}
        comfyStatus={comfyStatus}
        scanStatus={scanStatus}
        thumbStatus={thumbStatus}
        onTriggerScan={handleTriggerScan}
        onOpenWorkflowCreate={() => setShowWorkflowCreate(true)}
        onOpenSettings={() => setShowSettings(true)}
        onControlComfy={async (action) => {
          if (action === "stop" && !window.confirm("确认关闭正在运行的 ComfyUI 吗？")) return;
          try {
            const res = await api.controlComfy(action);
            showToast(res.message || "指令已发送");
          } catch (e: any) {
            showToast(`操作失败: ${e.message}`, "err");
          }
        }}
      />

      <LiveProgressBar
        status={comfyStatus}
        onInterrupt={async () => {
          try {
            await api.interruptComfy();
            showToast("已发送中断指令到 ComfyUI");
          } catch (e: any) {
            showToast(`中断失败: ${e.message}`, "err");
          }
        }}
      />

      {/* Active Filter Context Bar + Right-Aligned Multi-Select Menu */}
      {activeTab === "gallery" &&
        (checkedList.length > 0 ||
          filter.recipeHash ||
          filter.lora ||
          filter.modelFamily ||
          filter.baseModel ||
          filter.folder !== "__ALL__") && (
          <div className="px-4 py-1.5 bg-[#111520] border-b border-zinc-800/80 flex flex-wrap items-center justify-between gap-2 text-[11px]">
            <div className="flex flex-wrap items-center gap-2 min-w-0">
              {(filter.folder !== "__ALL__" ||
                filter.recipeHash ||
                filter.lora ||
                filter.modelFamily ||
                filter.baseModel) && <span className="text-zinc-500 whitespace-nowrap">当前筛选:</span>}
              {filter.folder !== "__ALL__" && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-amber-500/15 text-amber-200 border border-amber-500/30 whitespace-nowrap">
                  目录: {filter.folder || "根目录"}
                  <button type="button" onClick={() => handleFilterChange({ folder: "__ALL__", folderExact: false })}>
                    <X className="w-3 h-3" />
                  </button>
                </span>
              )}
              {filter.recipeHash && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-indigo-500/20 text-indigo-200 border border-indigo-500/40 whitespace-nowrap">
                  同配方抽卡组 #{filter.recipeHash.slice(0, 8)}
                  <button type="button" onClick={() => handleFilterChange({ recipeHash: "" })}>
                    <X className="w-3 h-3" />
                  </button>
                </span>
              )}
              {filter.lora && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-purple-500/20 text-purple-200 border border-purple-500/40 whitespace-nowrap">
                  LoRA: {filter.lora.split("/").pop()}
                  <button type="button" onClick={() => handleFilterChange({ lora: "" })}>
                    <X className="w-3 h-3" />
                  </button>
                </span>
              )}
              {filter.modelFamily && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-cyan-500/20 text-cyan-200 border border-cyan-500/40 whitespace-nowrap">
                  模型: {filter.modelFamily}
                  <button type="button" onClick={() => handleFilterChange({ modelFamily: "" })}>
                    <X className="w-3 h-3" />
                  </button>
                </span>
              )}
              {filter.baseModel && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-sky-500/20 text-sky-200 border border-sky-500/40 whitespace-nowrap">
                  底模: {filter.baseModel.split("/").pop()}
                  <button type="button" onClick={() => handleFilterChange({ baseModel: "" })}>
                    <X className="w-3 h-3" />
                  </button>
                </span>
              )}
            </div>

            {checkedList.length > 0 && (
              <div className="ml-auto flex items-center gap-1.5 bg-emerald-950/50 border border-emerald-500/30 rounded-lg px-2.5 py-1 shrink-0">
                <span className="text-xs text-emerald-300 font-medium whitespace-nowrap">多选 {checkedList.length}</span>
                <button
                  type="button"
                  onClick={() => setCheckedIds(new Set(items.map((x) => x.id)))}
                  className="px-2 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs whitespace-nowrap"
                  title="全选当前已加载的全部资源"
                >
                  全选
                </button>
                {checkedList.length === 2 && (
                  <button
                    type="button"
                    onClick={() => setCompareIds([checkedList[0], checkedList[1]])}
                    className="px-2 py-0.5 rounded bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium flex items-center gap-1 whitespace-nowrap"
                  >
                    <GitCompare className="w-3.5 h-3.5 shrink-0" />
                    A/B 对比 Diff
                  </button>
                )}
                {filter.showDeleted ? (
                  <>
                    <button
                      type="button"
                      onClick={handleBatchRestore}
                      className="px-2 py-0.5 rounded bg-zinc-700 hover:bg-zinc-600 text-zinc-100 text-xs flex items-center gap-1 whitespace-nowrap"
                    >
                      <RotateCcw className="w-3 h-3 shrink-0" />
                      恢复
                    </button>
                    <button
                      type="button"
                      onClick={handleBatchPurge}
                      className="px-2 py-0.5 rounded bg-rose-600 hover:bg-rose-500 text-white text-xs flex items-center gap-1 whitespace-nowrap"
                    >
                      <Trash2 className="w-3 h-3 shrink-0" />
                      彻底清理磁盘
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={handleBatchTrash}
                    className="px-2 py-0.5 rounded bg-rose-600/80 hover:bg-rose-500 text-white text-xs flex items-center gap-1 whitespace-nowrap"
                  >
                    <Trash2 className="w-3 h-3 shrink-0" />
                    移入回收站
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setCheckedIds(new Set())}
                  className="text-zinc-400 hover:text-white p-0.5 shrink-0"
                  title="取消选择 (Esc)"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            )}
          </div>
        )}

      {/* Main Workspace */}
      <div className="flex-1 flex min-h-0 overflow-hidden relative">
        {activeTab === "gallery" && (
          <>
            <Sidebar
              facets={facets}
              filter={filter}
              onFilterChange={handleFilterChange}
              onTriggerScan={handleTriggerScan}
              onFolderReveal={async (folder) => {
                try {
                  await api.revealFolder(folder);
                } catch (e: any) {
                  showToast(e.message, "err");
                }
              }}
              onFolderRename={async (folder, currentName) => {
                const next = window.prompt(`重命名文件夹 "${folder}" 为：`, currentName);
                if (!next || next.trim() === currentName) return;
                try {
                  const res = await api.renameFolder(folder, next.trim());
                  if (filter.folder === folder) {
                    handleFilterChange({ folder: res.new_folder });
                  }
                  loadFacets();
                  loadAssets(true);
                  showToast(`文件夹已重命名为 ${res.new_folder}`);
                } catch (e: any) {
                  showToast(`重命名失败: ${e.message}`, "err");
                }
              }}
              onFolderDelete={async (folder, count) => {
                if (!window.confirm(`确认删除文件夹 "${folder}"（包含 ${count} 项资源）吗？\n\n文件将安全移入 Windows 回收站。`)) {
                  return;
                }
                try {
                  const res = await api.deleteFolder(folder);
                  if (filter.folder === folder || filter.folder.startsWith(folder + "/")) {
                    handleFilterChange({ folder: "__ALL__", folderExact: false });
                  }
                  loadFacets();
                  loadAssets(true);
                  showToast(`已将文件夹移入回收站（清理 ${res.removed} 条记录）`);
                } catch (e: any) {
                  showToast(`删除失败: ${e.message}`, "err");
                }
              }}
            />
            <VirtualMasonry
              items={items}
              total={total}
              loading={loading}
              selectedId={selectedId}
              checkedIds={checkedIds}
              cardMinWidth={cardMinWidth}
              onSelect={(a) => setSelectedId(a.id)}
              onDoubleClickAsset={(a) => {
                const idx = items.findIndex((x) => x.id === a.id);
                if (idx >= 0) setLightboxIndex(idx);
              }}
              onToggleCheck={handleToggleCheck}
              onSetCheckedIds={setCheckedIds}
              onQuickRate={handleQuickRate}
              onQuickFlag={handleQuickFlag}
              onFilterRecipe={(hash) => handleFilterChange({ recipeHash: hash, collapseRecipes: false })}
              onLoadMore={() => loadAssets(false)}
            />
          </>
        )}

        {activeTab === "loras" && (
          <LoraMatrixView
            onSelectLora={(loraName) => {
              handleFilterChange({ lora: loraName, showDeleted: false });
              setActiveTab("gallery");
            }}
            onSelectAssetId={(id) => {
              setSelectedId(id);
              setActiveTab("gallery");
            }}
          />
        )}

        {activeTab === "snippets" && (
          <SnippetsView
            onToast={showToast}
            onApplyConvertedPrompt={(prefill) => {
              setWorkflowPrefill(prefill);
              setShowWorkflowCreate(true);
            }}
          />
        )}

        {/* Docked Right Inspector Pane (fixed 460px: never covers thumbnails & never jumps!) */}
        {selectedId !== null ? (
          <AssetDetailDrawer
            assetId={selectedId}
            refreshTick={detailRefreshTick}
            comfyStatus={comfyStatus}
            onClose={() => setSelectedId(null)}
            onSelectAssetId={(id) => setSelectedId(id)}
            onOpenRemix={(d) => setRemixDetail(d)}
            onFilterRecipe={(hash) => {
              handleFilterChange({ recipeHash: hash, collapseRecipes: false });
              setActiveTab("gallery");
            }}
            onFilterLora={(loraName) => {
              handleFilterChange({ lora: loraName, showDeleted: false });
              setActiveTab("gallery");
            }}
            onMutated={() => {
              loadFacets();
              loadAssets(true);
            }}
            onToast={showToast}
          />
        ) : (
          activeTab === "gallery" && (
            <FolderSummaryPanel
              filter={filter}
              items={items}
              total={total}
              onFilterLora={(loraName) => handleFilterChange({ lora: loraName, showDeleted: false })}
              onFilterModel={(baseModel) => handleFilterChange({ baseModel, showDeleted: false })}
            />
          )
        )}
      </div>

      {/* Modals */}
      {remixDetail && (
        <RemixModal
          detail={remixDetail}
          comfyStatus={comfyStatus}
          onClose={() => setRemixDetail(null)}
          onSaved={() => {
            setDetailRefreshTick((t) => t + 1);
            loadFacets();
            loadAssets(true);
          }}
          onSubmitted={(m) => showToast(m, "ok")}
          onError={(m) => showToast(m, "err")}
        />
      )}

      {showWorkflowCreate && (
        <WorkflowCreateModal
          comfyStatus={comfyStatus}
          initialPrefill={workflowPrefill}
          onClose={() => {
            setShowWorkflowCreate(false);
            setWorkflowPrefill(null);
          }}
          onOpenSettings={() => {
            setShowWorkflowCreate(false);
            setWorkflowPrefill(null);
            setShowSettings(true);
          }}
          onSubmitted={(m) => showToast(m, "ok")}
          onError={(m) => showToast(m, "err")}
        />
      )}

      {showSettings && (
        <SettingsModal
          onClose={() => setShowSettings(false)}
          onSaved={(m) => showToast(m, "ok")}
          onError={(m) => showToast(m, "err")}
        />
      )}

      {compareIds && <CompareModal assetIds={compareIds} onClose={() => setCompareIds(null)} />}

      {lightboxIndex !== null && items[lightboxIndex] && (
        <LightboxModal
          items={items}
          currentIndex={lightboxIndex}
          onChangeIndex={(idx) => {
            setLightboxIndex(idx);
            if (items[idx]) setSelectedId(items[idx].id);
          }}
          onClose={() => setLightboxIndex(null)}
        />
      )}

      {/* Toast */}
      {toast && (
        <div
          className={`fixed bottom-5 left-1/2 -translate-x-1/2 z-[60] px-4 py-2 rounded-xl shadow-2xl border text-xs font-medium backdrop-blur-md ${
            toast.tone === "err"
              ? "bg-rose-950/90 border-rose-500/50 text-rose-100"
              : "bg-zinc-900/95 border-indigo-500/50 text-zinc-100"
          }`}
        >
          {toast.msg}
        </div>
      )}
    </div>
  );
}
