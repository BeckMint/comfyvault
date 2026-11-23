import React, { useMemo } from "react";
import { Film, FolderOpen, HardDrive, Image as ImageIcon, Info, Keyboard, Sparkles } from "lucide-react";
import { formatBytes } from "../api";
import { useI18n } from "../i18n";
import type { AssetFilter, AssetListItem } from "../types";

interface Props {
  filter: AssetFilter;
  items: AssetListItem[];
  total: number;
  onFilterLora: (loraName: string) => void;
  onFilterModel: (baseModel: string) => void;
}

export const FolderSummaryPanel: React.FC<Props> = ({
  filter,
  items,
  total,
  onFilterLora,
  onFilterModel,
}) => {
  const { t } = useI18n();
  const stats = useMemo(() => {
    let imgCount = 0;
    let vidCount = 0;
    let totalBytes = 0;
    const loraMap = new Map<string, number>();
    const modelMap = new Map<string, number>();

    for (const it of items) {
      if (it.media_type === "video") vidCount++;
      else imgCount++;
      totalBytes += it.file_size || 0;
      if (it.base_model) {
        modelMap.set(it.base_model, (modelMap.get(it.base_model) || 0) + 1);
      }
      for (const l of it.loras || []) {
        if (l.enabled) {
          loraMap.set(l.name, (loraMap.get(l.name) || 0) + 1);
        }
      }
    }

    const topLoras = Array.from(loraMap.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6);
    const topModels = Array.from(modelMap.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);

    return { imgCount, vidCount, totalBytes, topLoras, topModels };
  }, [items]);

  const scopeTitle =
    filter.showDeleted
      ? t("回收站", "Trash")
      : filter.folder !== "__ALL__"
      ? filter.folder || t("output 根目录", "output root")
      : filter.modelFamily
      ? `${t("模型", "Model")}: ${filter.modelFamily}`
      : filter.lora
      ? `LoRA: ${filter.lora.split("/").pop()}`
      : filter.recipeHash
      ? `${t("同配方抽卡组", "Recipe Group")} #${filter.recipeHash.slice(0, 8)}`
      : t("全部资源", "All Assets");

  return (
    <aside className="w-[460px] shrink-0 h-full bg-[#10131c] border-l border-zinc-800/90 flex flex-col overflow-hidden select-none">
      {/* Header */}
      <div className="h-12 px-4 border-b border-zinc-800/80 flex items-center gap-2 shrink-0">
        <FolderOpen className="w-4 h-4 text-amber-400 shrink-0" />
        <div className="min-w-0">
          <div className="text-xs font-semibold text-zinc-100 truncate" title={scopeTitle}>
            {scopeTitle}
          </div>
          <div className="text-[10px] text-zinc-500">
            {t("当前视图概览 · 点击任意缩略图查看详细参数", "Overview · Click any thumbnail to inspect parameters")}
          </div>
        </div>
      </div>

      {/* Scrollable Overview */}
      <div className="flex-1 overflow-y-auto p-4 space-y-5">
        {/* Stat Cards */}
        <div className="grid grid-cols-2 gap-2.5">
          <div className="p-3 rounded-xl bg-[#151925] border border-zinc-800/80">
            <div className="text-[11px] text-zinc-500 flex items-center gap-1.5">
              <Info className="w-3.5 h-3.5 text-indigo-400" />
              {t("资源总数", "Total Assets")}
            </div>
            <div className="text-xl font-bold font-mono text-white mt-1">{total}</div>
            <div className="text-[10px] text-zinc-500 mt-0.5">
              {t(`当前已加载 ${items.length} 项`, `Loaded ${items.length} items`)}
            </div>
          </div>

          <div className="p-3 rounded-xl bg-[#151925] border border-zinc-800/80">
            <div className="text-[11px] text-zinc-500 flex items-center gap-1.5">
              <HardDrive className="w-3.5 h-3.5 text-sky-400" />
              {t("已加载体积", "Loaded Size")}
            </div>
            <div className="text-xl font-bold font-mono text-white mt-1">{formatBytes(stats.totalBytes)}</div>
            <div className="text-[10px] text-zinc-400 mt-0.5 flex items-center gap-2">
              <span className="inline-flex items-center gap-0.5">
                <ImageIcon className="w-3 h-3 text-sky-400" /> {stats.imgCount}
              </span>
              <span className="inline-flex items-center gap-0.5">
                <Film className="w-3 h-3 text-purple-400" /> {stats.vidCount}
              </span>
            </div>
          </div>
        </div>

        {/* Top LoRAs in current folder/view */}
        <section className="space-y-2">
          <h3 className="text-xs font-semibold text-zinc-300 flex items-center gap-1.5">
            <Sparkles className="w-3.5 h-3.5 text-purple-400" />
            {t("当前常用 LoRA", "Top LoRAs in View")}
          </h3>
          <div className="p-3 rounded-xl bg-[#151925] border border-zinc-800/80 space-y-1.5">
            {stats.topLoras.length === 0 ? (
              <div className="text-xs text-zinc-500">{t("当前目录下暂无 LoRA 记录", "No LoRAs in current view")}</div>
            ) : (
              stats.topLoras.map(([name, cnt]) => (
                <button
                  key={name}
                  type="button"
                  onClick={() => onFilterLora(name)}
                  className="w-full flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg bg-[#0d1018] hover:bg-purple-600/20 border border-zinc-800/80 hover:border-purple-500/40 text-xs transition-colors"
                  title={name}
                >
                  <span className="truncate text-purple-200">{name.split("/").pop()}</span>
                  <span className="font-mono text-[11px] text-zinc-400 shrink-0">{cnt} {t("张", "items")}</span>
                </button>
              ))
            )}
          </div>
        </section>

        {/* Top Base Models in current folder/view */}
        <section className="space-y-2">
          <h3 className="text-xs font-semibold text-zinc-300">{t("当前常用底模 / UNET", "Top Models / UNETs")}</h3>
          <div className="p-3 rounded-xl bg-[#151925] border border-zinc-800/80 space-y-1.5">
            {stats.topModels.length === 0 ? (
              <div className="text-xs text-zinc-500">{t("当前目录下暂无底模记录", "No models in current view")}</div>
            ) : (
              stats.topModels.map(([name, cnt]) => (
                <button
                  key={name}
                  type="button"
                  onClick={() => onFilterModel(name)}
                  className="w-full flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg bg-[#0d1018] hover:bg-sky-600/20 border border-zinc-800/80 hover:border-sky-500/40 text-xs transition-colors"
                  title={name}
                >
                  <span className="truncate text-sky-200 font-mono text-[11px]">{name.split("/").pop()}</span>
                  <span className="font-mono text-[11px] text-zinc-400 shrink-0">{cnt} {t("张", "items")}</span>
                </button>
              ))
            )}
          </div>
        </section>

        {/* Shortcut Cheat Sheet */}
        <section className="space-y-2">
          <h3 className="text-xs font-semibold text-zinc-300 flex items-center gap-1.5">
            <Keyboard className="w-3.5 h-3.5 text-zinc-400" />
            {t("快捷操作指南", "Shortcuts")}
          </h3>
          <div className="p-3 rounded-xl bg-[#151925] border border-zinc-800/80 space-y-1.5 text-[11px] text-zinc-400">
            <div className="flex justify-between">
              <span>{t("双击缩略图", "Double-click card")}</span>
              <span className="text-zinc-200">{t("Picasa 硬件加速原图查看", "WebGL2 Lightbox Viewer")}</span>
            </div>
            <div className="flex justify-between">
              <span>{t("左键拖拽拉框", "Left-drag marquee")}</span>
              <span className="text-zinc-200">{t("框选多选 / A/B 对比", "Multi-select / A/B Compare")}</span>
            </div>
            <div className="flex justify-between">
              <span>{t("右键左侧文件夹", "Right-click folder")}</span>
              <span className="text-zinc-200">{t("打开 / 重命名 / 删除目录", "Reveal / Rename / Delete")}</span>
            </div>
            <div className="flex justify-between">
              <span>{t("数字键 1 ~ 5 / P / X", "Keys 1–5 / P / X")}</span>
              <span className="text-zinc-200">{t("打星 / 精选 / 废片", "Rate / Pick / Reject")}</span>
            </div>
            <div className="flex justify-between">
              <span>{t("方向键 ← / → / Esc", "Arrows ← / → / Esc")}</span>
              <span className="text-zinc-200">{t("切换选中 / 退出多选或关闭", "Navigate / Clear selection")}</span>
            </div>
          </div>
        </section>
      </div>
    </aside>
  );
};
