import React, { useEffect, useRef, useState } from "react";
import {
  BookMarked,
  ChevronDown,
  Columns2,
  ExternalLink,
  Grid,
  Languages,
  Layers,
  Play,
  Power,
  RefreshCw,
  RotateCw,
  Search,
  Settings,
  Workflow,
  X,
} from "lucide-react";
import { useI18n } from "../i18n";
import type { AssetFilter, ComfyStatus, ScanStatus, ThumbStatus } from "../types";

export type ActiveTab = "gallery" | "loras" | "snippets";

interface Props {
  activeTab: ActiveTab;
  onTabChange: (tab: ActiveTab) => void;
  filter: AssetFilter;
  onFilterChange: (patch: Partial<AssetFilter>) => void;
  onResetFilters: () => void;
  cardMinWidth: number;
  onCardMinWidthChange: (w: number) => void;
  total: number;
  comfyStatus: ComfyStatus;
  scanStatus: ScanStatus;
  thumbStatus: ThumbStatus;
  onTriggerScan: () => void;
  onOpenWorkflowCreate: () => void;
  onOpenSettings: () => void;
  onControlComfy: (action: "start" | "stop" | "restart") => void;
}

export const TopBar: React.FC<Props> = ({
  activeTab,
  onTabChange,
  filter,
  onFilterChange,
  onResetFilters,
  cardMinWidth,
  onCardMinWidthChange,
  total,
  comfyStatus,
  scanStatus,
  thumbStatus,
  onTriggerScan,
  onOpenWorkflowCreate,
  onOpenSettings,
  onControlComfy,
}) => {
  const { lang, toggleLang, t } = useI18n();
  const [comfyMenuOpen, setComfyMenuOpen] = useState(false);
  const comfyMenuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!comfyMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (comfyMenuRef.current && !comfyMenuRef.current.contains(e.target as Node)) {
        setComfyMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setComfyMenuOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [comfyMenuOpen]);

  const isGenerating =
    comfyStatus.online &&
    (Boolean(comfyStatus.executing_prompt_id) || Boolean(comfyStatus.executing_node) || comfyStatus.queue_remaining > 0);
  const hasActiveFilter =
    filter.folder !== "__ALL__" ||
    filter.mediaType !== "" ||
    filter.search !== "" ||
    filter.lora !== "" ||
    filter.modelFamily !== "" ||
    filter.baseModel !== "" ||
    filter.workflowHash !== "" ||
    filter.recipeHash !== "" ||
    filter.tagId !== null ||
    filter.minRating > 0 ||
    filter.flag !== "" ||
    filter.comfyVersion !== "" ||
    filter.showDeleted;

  const progressPct =
    comfyStatus.progress_max > 0
      ? Math.round((comfyStatus.progress_value / comfyStatus.progress_max) * 100)
      : 0;

  return (
    <header className="h-14 shrink-0 bg-[#10131c] border-b border-zinc-800/90 px-4 flex items-center justify-between gap-3 select-none">
      {/* Brand + Primary Tabs */}
      <div className="flex items-center gap-4 shrink-0">
        <div className="flex items-center gap-2">
          <img
            src="/favicon.svg"
            alt="ComfyVault"
            className="w-8 h-8 rounded-lg shadow-lg shadow-indigo-500/20 shrink-0"
            draggable={false}
          />
          <span className="font-bold text-sm tracking-wide text-white">ComfyVault</span>
        </div>

        <nav className="flex items-center bg-[#0b0d12] p-0.5 rounded-lg border border-zinc-800">
          <button
            type="button"
            onClick={() => onTabChange("gallery")}
            className={`px-3 py-1 rounded-md text-xs font-medium flex items-center gap-1.5 transition-colors ${
              activeTab === "gallery" ? "bg-indigo-600 text-white" : "text-zinc-400 hover:text-zinc-200"
            }`}
          >
            <Grid className="w-3.5 h-3.5" />
            {t("资产库", "Gallery")}
          </button>
          <button
            type="button"
            onClick={() => onTabChange("loras")}
            className={`px-3 py-1 rounded-md text-xs font-medium flex items-center gap-1.5 transition-colors ${
              activeTab === "loras" ? "bg-indigo-600 text-white" : "text-zinc-400 hover:text-zinc-200"
            }`}
          >
            <Layers className="w-3.5 h-3.5" />
            {t("LoRA 档案", "LoRAs")}
          </button>
          <button
            type="button"
            onClick={() => onTabChange("snippets")}
            className={`px-3 py-1 rounded-md text-xs font-medium flex items-center gap-1.5 transition-colors ${
              activeTab === "snippets" ? "bg-indigo-600 text-white" : "text-zinc-400 hover:text-zinc-200"
            }`}
          >
            <BookMarked className="w-3.5 h-3.5" />
            {t("提示词库", "Prompts")}
          </button>
        </nav>
      </div>

      {/* Center: Search & Gallery Controls */}
      {activeTab === "gallery" && (
        <div className="flex items-center gap-2 flex-1 max-w-3xl">
          <div className="relative flex-1 min-w-[180px]">
            <Search className="w-3.5 h-3.5 text-zinc-500 absolute left-2.5 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={filter.search}
              onChange={(e) => onFilterChange({ search: e.target.value })}
              placeholder={t("搜索提示词、LoRA、底模、文件名、笔记...", "Search prompts, LoRAs, models, files, notes...")}
              className="w-full h-8 pl-8 pr-7 rounded-lg bg-[#0b0d12] border border-zinc-800 focus:border-indigo-500 focus:outline-none text-xs text-zinc-100 placeholder:text-zinc-500"
            />
            {filter.search && (
              <button
                type="button"
                onClick={() => onFilterChange({ search: "" })}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-200"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          <select
            value={filter.sort}
            onChange={(e) => onFilterChange({ sort: e.target.value as AssetFilter["sort"] })}
            className="h-8 px-2 rounded-lg bg-[#0b0d12] border border-zinc-800 text-xs text-zinc-200 focus:outline-none focus:border-indigo-500"
          >
            <option value="newest">{t("最新生成", "Newest")}</option>
            <option value="oldest">{t("最早生成", "Oldest")}</option>
            <option value="rating">{t("星级最高", "Top Rated")}</option>
            <option value="largest">{t("文件最大", "Largest")}</option>
            <option value="name">{t("文件名", "Filename")}</option>
          </select>

          <button
            type="button"
            onClick={() => onFilterChange({ collapseRecipes: !filter.collapseRecipes })}
            title={t(
              "开启后，相同参数/提示词仅 Seed 不同的抽卡组会折叠为一张代表卡片",
              "Collapse assets sharing the same prompt/params (differing only by Seed) into a single card"
            )}
            className={`h-8 px-2.5 rounded-lg border text-xs font-medium flex items-center gap-1.5 shrink-0 transition-colors ${
              filter.collapseRecipes
                ? "bg-indigo-600/20 border-indigo-500/60 text-indigo-300"
                : "bg-[#0b0d12] border-zinc-800 text-zinc-400 hover:text-zinc-200"
            }`}
          >
            <Columns2 className="w-3.5 h-3.5" />
            {t("按配方折叠", "Group Seeds")}
          </button>

          <div className="hidden xl:flex items-center gap-1.5 text-[11px] text-zinc-500 pl-1">
            <span>{t("缩放", "Zoom")}</span>
            <input
              type="range"
              min={160}
              max={340}
              step={20}
              value={cardMinWidth}
              onChange={(e) => onCardMinWidthChange(Number(e.target.value))}
              className="w-16 accent-indigo-500"
            />
          </div>

          {hasActiveFilter && (
            <button
              type="button"
              onClick={onResetFilters}
              className="h-8 px-2 rounded-lg bg-zinc-800/80 hover:bg-zinc-700 text-xs text-zinc-300 flex items-center gap-1 shrink-0"
              title={t("重置所有筛选", "Reset all filters")}
            >
              <X className="w-3.5 h-3.5" />
              {t("重置", "Reset")}
            </button>
          )}

          <span className="text-[11px] text-zinc-500 shrink-0 font-mono whitespace-nowrap">
            {total} {t("项", "items")}
          </span>
        </div>
      )}

      {/* Right (left-to-right): ComfyUI Status/Control -> Scan -> Settings -> Create from Workflow */}
      <div className="flex items-center gap-2 shrink-0">
        {thumbStatus.running && thumbStatus.total > 0 && (
          <span
            className="h-8 px-2.5 rounded-lg bg-indigo-950/50 border border-indigo-500/30 text-[11px] text-indigo-300 flex items-center gap-1.5 font-mono whitespace-nowrap"
            title="后台低并发预生成 WebP 缩略图，生成后永久缓存"
          >
            <span className="w-1.5 h-1.5 rounded-full bg-indigo-400 animate-pulse" />
            缩略图 {thumbStatus.done}/{thumbStatus.total}
          </span>
        )}

        {/* 1. ComfyUI Status (generating: live progress link; idle/offline: status + control dropdown) */}
        <div ref={comfyMenuRef} className="relative">
          {isGenerating ? (
            <a
              href={comfyStatus.comfy_url || "http://127.0.0.1:8188"}
              target="_blank"
              rel="noreferrer"
              className="h-8 px-2.5 rounded-lg border text-xs font-medium flex items-center gap-2 transition-colors bg-emerald-950/40 border-emerald-500/40 text-emerald-300 hover:bg-emerald-950/70 whitespace-nowrap"
              title={`ComfyUI 正在工作 | 版本: ${comfyStatus.comfy_version}`}
            >
              <span className="w-2 h-2 rounded-full bg-emerald-400 shadow-[0_0_8px_#34d399] animate-pulse" />
              <span>
                {comfyStatus.executing_prompt_id
                  ? `${t("生成中", "Running")} ${progressPct}%`
                  : `${t("排队", "Queue")} ${comfyStatus.queue_remaining}`}
              </span>
              <ExternalLink className="w-3 h-3 opacity-70" />
            </a>
          ) : (
            <button
              type="button"
              onClick={() => setComfyMenuOpen((v) => !v)}
              className={`h-8 px-2.5 rounded-lg border text-xs font-medium flex items-center gap-2 transition-colors whitespace-nowrap ${
                comfyStatus.online
                  ? "bg-emerald-950/40 border-emerald-500/40 text-emerald-300 hover:bg-emerald-950/70"
                  : "bg-zinc-900 border-zinc-800 text-zinc-400 hover:text-zinc-200"
              }`}
              title={t(
                `点击管理 ComfyUI（启动 / 重启 / 关闭 / 打开） | 版本: ${comfyStatus.comfy_version}`,
                `Manage ComfyUI (Start / Restart / Stop / Open) | Version: ${comfyStatus.comfy_version}`
              )}
            >
              <span
                className={`w-2 h-2 rounded-full ${
                  comfyStatus.online ? "bg-emerald-400 shadow-[0_0_8px_#34d399]" : "bg-zinc-500"
                }`}
              />
              <span>{comfyStatus.online ? t("ComfyUI 在线", "ComfyUI Online") : t("ComfyUI 离线", "ComfyUI Offline")}</span>
              <ChevronDown className={`w-3.5 h-3.5 opacity-75 transition-transform ${comfyMenuOpen ? "rotate-180" : ""}`} />
            </button>
          )}

          {comfyMenuOpen && !isGenerating && (
            <div className="absolute right-0 top-10 z-50 w-52 py-1.5 rounded-xl bg-[#161b28] border border-zinc-700/90 shadow-2xl text-xs text-zinc-200">
              <div className="px-3 py-1.5 border-b border-zinc-800 mb-1">
                <div className="text-[11px] font-semibold text-zinc-100 flex items-center gap-1.5">
                  <span className={`w-2 h-2 rounded-full ${comfyStatus.online ? "bg-emerald-400" : "bg-zinc-500"}`} />
                  {comfyStatus.online ? t("运行中 (8188)", "Running (8188)") : t("已停止", "Stopped")}
                </div>
                {comfyStatus.comfy_version && (
                  <div className="text-[10px] text-zinc-500 font-mono truncate mt-0.5" title={comfyStatus.comfy_version}>
                    {comfyStatus.comfy_version}
                  </div>
                )}
              </div>

              <a
                href={comfyStatus.comfy_url || "http://127.0.0.1:8188"}
                target="_blank"
                rel="noreferrer"
                onClick={() => setComfyMenuOpen(false)}
                className="w-full px-3 py-1.5 hover:bg-zinc-800 flex items-center gap-2 text-left"
              >
                <ExternalLink className="w-3.5 h-3.5 text-sky-400" />
                {t("打开 ComfyUI 网页", "Open ComfyUI Web")}
              </a>

              {!comfyStatus.online && (
                <button
                  type="button"
                  onClick={() => {
                    setComfyMenuOpen(false);
                    onControlComfy("start");
                  }}
                  className="w-full px-3 py-1.5 hover:bg-zinc-800 flex items-center gap-2 text-left text-emerald-300"
                >
                  <Play className="w-3.5 h-3.5 fill-current" />
                  {t("启动 ComfyUI", "Start ComfyUI")}
                </button>
              )}

              {comfyStatus.online && (
                <>
                  <button
                    type="button"
                    onClick={() => {
                      setComfyMenuOpen(false);
                      onControlComfy("restart");
                    }}
                    className="w-full px-3 py-1.5 hover:bg-zinc-800 flex items-center gap-2 text-left text-amber-300"
                  >
                    <RotateCw className="w-3.5 h-3.5" />
                    {t("重启 ComfyUI", "Restart ComfyUI")}
                  </button>
                  <div className="my-1 border-t border-zinc-800" />
                  <button
                    type="button"
                    onClick={() => {
                      setComfyMenuOpen(false);
                      onControlComfy("stop");
                    }}
                    className="w-full px-3 py-1.5 hover:bg-rose-600/25 flex items-center gap-2 text-left text-rose-300"
                  >
                    <Power className="w-3.5 h-3.5" />
                    {t("关闭 ComfyUI", "Stop ComfyUI")}
                  </button>
                </>
              )}
            </div>
          )}
        </div>

        {/* 2. Scan Output Directory */}
        <button
          type="button"
          onClick={onTriggerScan}
          disabled={scanStatus.scanning}
          className="h-8 px-2.5 rounded-lg bg-[#161a25] hover:bg-zinc-800 border border-zinc-800 text-xs text-zinc-200 flex items-center gap-1.5 disabled:opacity-70 whitespace-nowrap"
          title={t("增量扫描相册/输出目录", "Incremental scan of output/gallery directories")}
        >
          <RefreshCw className={`w-3.5 h-3.5 ${scanStatus.scanning ? "animate-spin text-indigo-400" : ""}`} />
          {scanStatus.scanning
            ? `${t("扫描", "Scan")} ${scanStatus.scanned}/${scanStatus.total || "..."}`
            : t("扫描目录", "Scan")}
        </button>

        {/* 3. Language Toggle (ZH / EN) */}
        <button
          type="button"
          onClick={toggleLang}
          className="h-8 px-2 rounded-lg bg-[#161a25] hover:bg-zinc-800 border border-zinc-800 text-xs font-semibold text-zinc-200 flex items-center gap-1 shrink-0"
          title={t("切换为 English", "Switch to 中文")}
        >
          <Languages className="w-3.5 h-3.5 text-sky-400" />
          <span>{lang === "zh" ? "EN" : "中文"}</span>
        </button>

        {/* 4. Settings */}
        <button
          type="button"
          onClick={onOpenSettings}
          className="h-8 w-8 rounded-lg bg-[#161a25] hover:bg-zinc-800 border border-zinc-800 text-zinc-300 hover:text-white flex items-center justify-center shrink-0"
          title={t("系统外观、相册与工作流目录配置", "Appearance, Gallery & Workflow Directories")}
        >
          <Settings className="w-4 h-4" />
        </button>

        {/* 5. Create from Workflow */}
        <button
          type="button"
          onClick={onOpenWorkflowCreate}
          className="h-8 px-3 rounded-lg bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 text-xs font-semibold text-white shadow-md shadow-indigo-600/20 flex items-center gap-1.5 transition-all whitespace-nowrap"
          title={t(
            "选择已搭建好的工作流，按 Node 编号填写参数直接提交 ComfyUI 生成",
            "Pick a ComfyUI workflow, edit node parameters, and queue generation"
          )}
        >
          <Workflow className="w-3.5 h-3.5" />
          {t("从工作流创建", "New from Workflow")}
        </button>
      </div>
    </header>
  );
};
