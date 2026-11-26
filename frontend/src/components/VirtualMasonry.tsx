import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Columns2, Eye, EyeOff, Film, Layers, Star, ThumbsDown, ThumbsUp } from "lucide-react";
import { useI18n } from "../i18n";
import type { AssetListItem } from "../types";

interface Props {
  items: AssetListItem[];
  total: number;
  loading: boolean;
  selectedId: number | null;
  checkedIds: Set<number>;
  cardMinWidth: number;
  onSelect: (asset: AssetListItem) => void;
  onDoubleClickAsset: (asset: AssetListItem) => void;
  onToggleCheck: (id: number) => void;
  onSetCheckedIds: (ids: Set<number>) => void;
  onQuickRate: (id: number, rating: number) => void;
  onQuickFlag: (id: number, flag: "" | "pick" | "reject") => void;
  onQuickHide: (item: AssetListItem) => void;
  onOpenRefCompare?: (item: AssetListItem) => void;
  onFilterRecipe: (recipeHash: string) => void;
  onLoadMore: () => void;
}

interface PlacedItem {
  item: AssetListItem;
  x: number;
  y: number;
  w: number;
  h: number;
}

const GAP = 12;
const PADDING = 16;
const FOOTER_H = 54;
const OVERSCAN = 650;

const AssetCard = React.memo(function AssetCard({
  placed,
  isSelected,
  isChecked,
  isMultiSelect,
  onSelect,
  onDoubleClickAsset,
  onToggleCheck,
  onQuickRate,
  onQuickFlag,
  onQuickHide,
  onOpenRefCompare,
  onFilterRecipe,
}: {
  placed: PlacedItem;
  isSelected: boolean;
  isChecked: boolean;
  isMultiSelect: boolean;
  onSelect: (a: AssetListItem) => void;
  onDoubleClickAsset: (a: AssetListItem) => void;
  onToggleCheck: (id: number) => void;
  onQuickRate: (id: number, r: number) => void;
  onQuickFlag: (id: number, f: "" | "pick" | "reject") => void;
  onQuickHide: (a: AssetListItem) => void;
  onOpenRefCompare?: (a: AssetListItem) => void;
  onFilterRecipe: (hash: string) => void;
}) {
  const { t } = useI18n();
  const { item, x, y, w, h } = placed;
  const mediaH = h - FOOTER_H;
  const [hoverVideo, setHoverVideo] = useState(false);
  const hoverTimer = useRef<number | null>(null);

  const handleMouseEnter = () => {
    if (item.media_type !== "video") return;
    hoverTimer.current = window.setTimeout(() => setHoverVideo(true), 180);
  };

  const handleMouseLeave = () => {
    if (hoverTimer.current) {
      window.clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
    if (hoverVideo) setHoverVideo(false);
  };

  useEffect(() => {
    return () => {
      if (hoverTimer.current) window.clearTimeout(hoverTimer.current);
    };
  }, []);

  const firstLora = item.loras?.[0]?.name?.split("/").pop()?.replace(/\.safetensors$/i, "");

  return (
    <div
      className={`masonry-card group absolute top-0 left-0 rounded-xl overflow-hidden bg-[#141720] border transition-colors cursor-pointer select-none ${
        isSelected
          ? "border-indigo-500 ring-2 ring-indigo-500/40 z-10"
          : isChecked
          ? "border-emerald-400 ring-2 ring-emerald-400/30 z-10"
          : "border-zinc-800/80 hover:border-zinc-600"
      }`}
      style={{
        width: w,
        height: h,
        transform: `translate3d(${x}px, ${y}px, 0)`,
      }}
      onClick={() => {
        if (isMultiSelect) {
          onToggleCheck(item.id);
        } else {
          onSelect(item);
        }
      }}
      onDoubleClick={(e) => {
        e.stopPropagation();
        onDoubleClickAsset(item);
      }}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {/* Media Box */}
      <div className="relative w-full bg-[#0e1017] overflow-hidden" style={{ height: mediaH }}>
        <img
          src={item.thumb_url}
          alt={item.filename}
          loading="lazy"
          decoding="async"
          className="w-full h-full object-cover block"
          draggable={false}
        />

        {hoverVideo && item.media_type === "video" && (
          <video
            src={item.media_url}
            autoPlay
            loop
            muted
            playsInline
            className="absolute inset-0 w-full h-full object-cover"
          />
        )}

        {/* Top-left Badges */}
        <div className="absolute top-2 left-2 flex flex-wrap items-center gap-1 pointer-events-auto">
          {item.media_type === "video" && (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-black/75 backdrop-blur-sm text-[11px] font-medium text-sky-300 border border-sky-400/30">
              <Film className="w-3 h-3" />
              {item.duration ? `${item.duration.toFixed(1)}s` : "VIDEO"}
            </span>
          )}
          {item.recipe_hash && item.recipe_count > 1 && (
            <button
              type="button"
              title={t(
                `相同参数/提示词共生成 ${item.recipe_count} 张，点击筛选该配方`,
                `${item.recipe_count} generations share these params/prompt — click to filter`
              )}
              onClick={(e) => {
                e.stopPropagation();
                if (item.recipe_hash) onFilterRecipe(item.recipe_hash);
              }}
              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-indigo-600/85 hover:bg-indigo-500 backdrop-blur-sm text-[11px] font-semibold text-white shadow"
            >
              <Layers className="w-3 h-3" />×{item.recipe_count}
            </button>
          )}
          {item.reference_image_url && onOpenRefCompare && (
            <button
              type="button"
              title={t("对比原图", "Compare Ref")}
              onClick={(e) => {
                e.stopPropagation();
                onOpenRefCompare(item);
              }}
              className="group/ref inline-flex items-center gap-1 p-1 hover:px-1.5 rounded-md bg-black/70 hover:bg-amber-500/95 backdrop-blur-sm text-[10px] font-semibold text-amber-300 hover:text-black border border-amber-400/45 shadow transition-all"
            >
              <Columns2 className="w-3.5 h-3.5 shrink-0" />
              <span className="hidden group-hover/ref:inline whitespace-nowrap">
                {t("对比原图", "Compare Ref")}
              </span>
            </button>
          )}
          {item.flag === "pick" && (
            <span className="px-1.5 py-0.5 rounded-md bg-emerald-600/85 text-[10px] font-semibold text-white">
              {t("精选", "Pick")}
            </span>
          )}
          {item.flag === "reject" && (
            <span className="px-1.5 py-0.5 rounded-md bg-rose-600/85 text-[10px] font-semibold text-white">
              {t("废片", "Reject")}
            </span>
          )}
        </div>

        {/* Top-right Multi-select Checkbox */}
        <button
          type="button"
          title={t("勾选用于 A/B 对比或批量操作", "Select for A/B compare or batch actions")}
          onClick={(e) => {
            e.stopPropagation();
            onToggleCheck(item.id);
          }}
          className={`absolute top-2 right-2 w-6 h-6 rounded-md flex items-center justify-center border transition-opacity ${
            isChecked
              ? "bg-emerald-500 border-emerald-400 text-black opacity-100"
              : isMultiSelect
              ? "bg-black/65 border-white/50 text-transparent opacity-100 hover:border-emerald-300"
              : "bg-black/60 border-white/30 text-transparent opacity-0 group-hover:opacity-100 hover:border-white"
          }`}
        >
          <Check className="w-3.5 h-3.5 stroke-[3]" />
        </button>

        {/* Bottom Hover Quick Actions (2-row layout: stars on top, pick/reject/hide below so buttons never clip) */}
        <div className="absolute inset-x-0 bottom-0 p-2 bg-gradient-to-t from-black/90 via-black/55 to-transparent opacity-0 group-hover:opacity-100 transition-opacity flex flex-col gap-1.5">
          <div className="flex items-center gap-0.5">
            {[1, 2, 3, 4, 5].map((s) => (
              <button
                key={s}
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onQuickRate(item.id, item.rating === s ? 0 : s);
                }}
                className="p-0.5 hover:scale-110 transition-transform"
              >
                <Star
                  className={`w-3.5 h-3.5 ${
                    s <= item.rating ? "fill-amber-400 text-amber-400" : "text-zinc-400 hover:text-amber-300"
                  }`}
                />
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              title={t("标记精选 (P)", "Pick (P)")}
              onClick={(e) => {
                e.stopPropagation();
                onQuickFlag(item.id, item.flag === "pick" ? "" : "pick");
              }}
              className={`p-1 rounded ${
                item.flag === "pick" ? "bg-emerald-500 text-black" : "bg-black/60 text-zinc-300 hover:text-emerald-400"
              }`}
            >
              <ThumbsUp className="w-3 h-3" />
            </button>
            <button
              type="button"
              title={t("标记废片 (X)", "Reject (X)")}
              onClick={(e) => {
                e.stopPropagation();
                onQuickFlag(item.id, item.flag === "reject" ? "" : "reject");
              }}
              className={`p-1 rounded ${
                item.flag === "reject" ? "bg-rose-500 text-white" : "bg-black/60 text-zinc-300 hover:text-rose-400"
              }`}
            >
              <ThumbsDown className="w-3 h-3" />
            </button>
            <button
              type="button"
              title={item.is_hidden ? t("取消隐藏", "Unhide asset") : t("隐藏该资产", "Hide asset")}
              onClick={(e) => {
                e.stopPropagation();
                onQuickHide(item);
              }}
              className={`p-1 rounded ${
                item.is_hidden ? "bg-amber-500 text-black" : "bg-black/60 text-zinc-300 hover:text-amber-300"
              }`}
            >
              {item.is_hidden ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}
            </button>
          </div>
        </div>
        {Boolean(item.is_hidden) && (
          <div className="absolute top-2 left-9 z-10 px-1.5 py-0.5 rounded bg-amber-500/90 text-black text-[10px] font-bold flex items-center gap-0.5 shadow">
            <EyeOff className="w-2.5 h-2.5" />
            {t("隐藏", "Hidden")}
          </div>
        )}
      </div>

      {/* Compact Card Footer */}
      <div className="h-[54px] px-2.5 py-1.5 flex flex-col justify-between bg-[#141720]">
        <div className="flex items-center justify-between gap-1.5">
          <span className="text-[12px] font-medium text-zinc-200 truncate" title={item.filename}>
            {item.filename}
          </span>
          {item.rating > 0 && (
            <span className="inline-flex items-center gap-0.5 text-[11px] text-amber-400 shrink-0">
              <Star className="w-3 h-3 fill-amber-400" />
              {item.rating}
            </span>
          )}
        </div>
        <div className="flex items-center justify-between gap-1 text-[11px] text-zinc-400">
          {firstLora ? (
            <span className="truncate px-1.5 py-0.2 rounded bg-purple-500/15 text-purple-300 border border-purple-500/20 max-w-[65%]">
              {firstLora}
            </span>
          ) : (
            <span className="truncate text-zinc-500 max-w-[65%]">
              {item.workflow_name || item.folder || "output"}
            </span>
          )}
          <span className="shrink-0 font-mono text-[10px] text-zinc-500">
            {item.width}×{item.height}
          </span>
        </div>
      </div>
    </div>
  );
});

export const VirtualMasonry: React.FC<Props> = ({
  items,
  total,
  loading,
  selectedId,
  checkedIds,
  cardMinWidth,
  onSelect,
  onDoubleClickAsset,
  onToggleCheck,
  onSetCheckedIds,
  onQuickRate,
  onQuickFlag,
  onQuickHide,
  onOpenRefCompare,
  onFilterRecipe,
  onLoadMore,
}) => {
  const { t } = useI18n();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [containerWidth, setContainerWidth] = useState(960);
  const [viewportHeight, setViewportHeight] = useState(800);
  const [scrollTop, setScrollTop] = useState(0);
  const rafRef = useRef<number | null>(null);

  // Marquee drag-selection state (in container scroll coordinates)
  const [marquee, setMarquee] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  const dragRef = useRef<{
    startX: number;
    startY: number;
    additive: boolean;
    baseChecked: Set<number>;
    active: boolean;
  } | null>(null);
  const suppressClickRef = useRef(false);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const w = Math.floor(entry.contentRect.width);
        const h = Math.floor(entry.contentRect.height);
        if (w > 0) {
          setContainerWidth((prev) => (Math.abs(w - prev) >= 4 ? w : prev));
        }
        if (h > 0) {
          setViewportHeight((prev) => (Math.abs(h - prev) >= 4 ? h : prev));
        }
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Precompute Masonry coordinates in O(N)
  const { placedItems, totalHeight } = useMemo(() => {
    const usableW = Math.max(240, containerWidth - PADDING * 2);
    const cols = Math.max(2, Math.floor((usableW + GAP) / (cardMinWidth + GAP)));
    const colW = Math.floor((usableW - GAP * (cols - 1)) / cols);
    const colHeights = new Float64Array(cols);
    colHeights.fill(PADDING);

    const placed: PlacedItem[] = new Array(items.length);
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      // Shortest column
      let minCol = 0;
      for (let c = 1; c < cols; c++) {
        if (colHeights[c] < colHeights[minCol]) minCol = c;
      }
      const rawRatio = it.width > 0 && it.height > 0 ? it.height / it.width : 1.0;
      const ratio = Math.max(0.45, Math.min(2.2, rawRatio));
      const mediaH = Math.round(colW * ratio);
      const cardH = mediaH + FOOTER_H;
      const x = PADDING + minCol * (colW + GAP);
      const y = colHeights[minCol];

      placed[i] = { item: it, x, y, w: colW, h: cardH };
      colHeights[minCol] = y + cardH + GAP;
    }

    let maxH = PADDING;
    for (let c = 0; c < cols; c++) {
      if (colHeights[c] > maxH) maxH = colHeights[c];
    }
    return { placedItems: placed, totalHeight: maxH + 40 };
  }, [items, containerWidth, cardMinWidth]);

  const handleScroll = useCallback(() => {
    if (rafRef.current !== null) return;
    rafRef.current = window.requestAnimationFrame(() => {
      rafRef.current = null;
      const el = containerRef.current;
      if (!el) return;
      const top = el.scrollTop;
      setScrollTop(top);
      if (items.length < total && !loading && top + el.clientHeight > totalHeight - 1400) {
        onLoadMore();
      }
    });
  }, [items.length, total, loading, totalHeight, onLoadMore]);

  useEffect(() => {
    return () => {
      if (rafRef.current !== null) window.cancelAnimationFrame(rafRef.current);
    };
  }, []);

  // Only render cards visible within [scrollTop - OVERSCAN, scrollTop + viewportHeight + OVERSCAN]
  const visibleItems = useMemo(() => {
    const minY = scrollTop - OVERSCAN;
    const maxY = scrollTop + viewportHeight + OVERSCAN;
    const res: PlacedItem[] = [];
    for (let i = 0; i < placedItems.length; i++) {
      const p = placedItems[i];
      if (p.y + p.h >= minY && p.y <= maxY) {
        res.push(p);
      }
    }
    return res;
  }, [placedItems, scrollTop, viewportHeight]);

  const isMultiSelect = checkedIds.size > 0;

  const handleContainerMouseDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      // Don't start marquee if user clicked a button/input/select
      if ((e.target as HTMLElement).closest("button, input, select, video")) return;
      const el = containerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const startX = e.clientX - rect.left + el.scrollLeft;
      const startY = e.clientY - rect.top + el.scrollTop;
      dragRef.current = {
        startX,
        startY,
        additive: e.ctrlKey || e.metaKey || e.shiftKey,
        baseChecked: new Set(checkedIds),
        active: false,
      };
    },
    [checkedIds]
  );

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const d = dragRef.current;
      const el = containerRef.current;
      if (!d || !el) return;
      const rect = el.getBoundingClientRect();
      const curX = Math.max(0, Math.min(el.scrollWidth, e.clientX - rect.left + el.scrollLeft));
      const curY = Math.max(0, Math.min(el.scrollHeight, e.clientY - rect.top + el.scrollTop));

      if (!d.active) {
        if (Math.hypot(curX - d.startX, curY - d.startY) < 8) return;
        d.active = true;
      }

      // Auto-scroll when dragging near top/bottom edges
      if (e.clientY < rect.top + 36) el.scrollTop -= 18;
      else if (e.clientY > rect.bottom - 36) el.scrollTop += 18;

      const x1 = Math.min(d.startX, curX);
      const y1 = Math.min(d.startY, curY);
      const x2 = Math.max(d.startX, curX);
      const y2 = Math.max(d.startY, curY);
      setMarquee({ x1, y1, x2, y2 });

      const next = d.additive ? new Set(d.baseChecked) : new Set<number>();
      for (let i = 0; i < placedItems.length; i++) {
        const p = placedItems[i];
        if (p.x < x2 && p.x + p.w > x1 && p.y < y2 && p.y + p.h > y1) {
          next.add(p.item.id);
        }
      }
      onSetCheckedIds(next);
    };

    const onUp = () => {
      const d = dragRef.current;
      if (!d) return;
      if (d.active) {
        suppressClickRef.current = true;
        window.setTimeout(() => {
          suppressClickRef.current = false;
        }, 60);
      }
      dragRef.current = null;
      setMarquee(null);
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [placedItems, onSetCheckedIds]);

  return (
    <div
      ref={containerRef}
      onScroll={handleScroll}
      onMouseDown={handleContainerMouseDown}
      onClickCapture={(e) => {
        if (suppressClickRef.current) {
          e.stopPropagation();
          e.preventDefault();
        }
      }}
      className="flex-1 h-full overflow-y-scroll overflow-x-hidden relative bg-[#0b0d12] select-none [scrollbar-gutter:stable]"
    >
      {items.length === 0 && !loading ? (
        <div className="h-full flex flex-col items-center justify-center text-zinc-500 gap-2 p-8">
          <div className="text-lg font-medium text-zinc-300">
            {t("当前筛选条件下暂无资源", "No assets match the current filters")}
          </div>
          <div className="text-sm">
            {t("可以切换左侧目录/筛选条件，或点击右上角“扫描目录”刷新资源库", "Adjust sidebar filters or click Scan in the top bar to refresh")}
          </div>
        </div>
      ) : (
        <div className="relative w-full" style={{ height: totalHeight }}>
          {visibleItems.map((placed) => (
            <AssetCard
              key={placed.item.id}
              placed={placed}
              isSelected={selectedId === placed.item.id}
              isChecked={checkedIds.has(placed.item.id)}
              isMultiSelect={isMultiSelect}
              onSelect={onSelect}
              onDoubleClickAsset={onDoubleClickAsset}
              onToggleCheck={onToggleCheck}
              onQuickRate={onQuickRate}
              onQuickFlag={onQuickFlag}
              onQuickHide={onQuickHide}
              onOpenRefCompare={onOpenRefCompare}
              onFilterRecipe={onFilterRecipe}
            />
          ))}

          {/* Marquee Selection Box */}
          {marquee && (
            <div
              className="pointer-events-none absolute z-30 rounded-md border border-emerald-400 bg-emerald-500/15 shadow-[0_0_0_1px_rgba(52,211,153,0.3)]"
              style={{
                left: marquee.x1,
                top: marquee.y1,
                width: marquee.x2 - marquee.x1,
                height: marquee.y2 - marquee.y1,
              }}
            />
          )}
        </div>
      )}

      {items.length < total && (
        <div className="flex justify-center py-6">
          <button
            type="button"
            disabled={loading}
            onClick={onLoadMore}
            className="px-4 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-xs text-zinc-200 border border-zinc-700 disabled:opacity-50"
          >
            {loading
              ? t("加载中...", "Loading...")
              : t(`加载更多（已显示 ${items.length} / ${total}）`, `Load More (${items.length} / ${total})`)}
          </button>
        </div>
      )}
    </div>
  );
};
