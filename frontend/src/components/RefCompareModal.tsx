import React, { useEffect, useMemo, useState } from "react";
import { Columns2, LayoutGrid, SlidersHorizontal, Wand2, X, ZoomIn, ZoomOut } from "lucide-react";
import { useI18n } from "../i18n";
import type { AssetDetail, AssetListItem, ReferenceImageEntry } from "../types";

interface Props {
  detail: AssetDetail | AssetListItem;
  onClose: () => void;
  onOpenRemix?: () => void;
}

export const RefCompareModal: React.FC<Props> = ({ detail, onClose, onOpenRemix }) => {
  const { t } = useI18n();

  const refList = useMemo<ReferenceImageEntry[]>(() => {
    if (detail.reference_images && detail.reference_images.length > 0) {
      return detail.reference_images;
    }
    if (detail.reference_image_url) {
      return [
        {
          url: detail.reference_image_url,
          label: t("反推参考原图", "Reference Image"),
          source: "reverse_prompt",
          filename: detail.reference_image || "",
        },
      ];
    }
    return [];
  }, [detail.reference_images, detail.reference_image_url, detail.reference_image, t]);

  const isMulti = refList.length > 1;
  const [mode, setMode] = useState<"grid" | "split" | "slider">(isMulti ? "grid" : "split");
  const [activeRefIdx, setActiveRefIdx] = useState(0);
  const [sliderPos, setSliderPos] = useState(50);
  const [zoomFull, setZoomFull] = useState(false);
  const [refDimsMap, setRefDimsMap] = useState<Record<string, { w: number; h: number }>>({});

  useEffect(() => {
    setMode(refList.length > 1 ? "grid" : "split");
    setActiveRefIdx(0);
    setZoomFull(false);
  }, [detail.id, refList.length]);

  useEffect(() => {
    window.dispatchEvent(new CustomEvent("comfyvault:pause-bg-videos"));
  }, [detail.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (refList.length === 0) return null;

  const activeRef = refList[Math.min(activeRefIdx, refList.length - 1)] || refList[0];
  const activeRefDims = refDimsMap[activeRef.url] || null;
  const totalGridTiles = refList.length + 1;

  const gridColsClass =
    totalGridTiles <= 2
      ? "grid-cols-1 md:grid-cols-2"
      : totalGridTiles === 3
      ? "grid-cols-1 md:grid-cols-3"
      : totalGridTiles === 4
      ? "grid-cols-1 sm:grid-cols-2"
      : totalGridTiles <= 6
      ? "grid-cols-2 lg:grid-cols-3"
      : "grid-cols-2 md:grid-cols-3 lg:grid-cols-4";

  const recordRefDims = (url: string, el: HTMLImageElement) => {
    if (el.naturalWidth > 0 && el.naturalHeight > 0) {
      setRefDimsMap((prev) => {
        const cur = prev[url];
        if (cur && cur.w === el.naturalWidth && cur.h === el.naturalHeight) return prev;
        return { ...prev, [url]: { w: el.naturalWidth, h: el.naturalHeight } };
      });
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/85 flex items-center justify-center p-3"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-[96vw] max-w-[1720px] h-[92vh] bg-[#0e111a] border border-zinc-700/90 rounded-2xl shadow-2xl flex flex-col overflow-hidden">
        {/* Header */}
        <div className="px-4 py-2.5 border-b border-zinc-800 flex flex-wrap items-center justify-between gap-2 shrink-0 bg-[#111521]">
          <div className="flex items-center gap-2.5 min-w-0">
            {isMulti ? (
              <LayoutGrid className="w-4 h-4 text-amber-400 shrink-0" />
            ) : (
              <Columns2 className="w-4 h-4 text-indigo-400 shrink-0" />
            )}
            <div className="min-w-0">
              <div className="text-xs font-semibold text-zinc-100 truncate">
                {isMulti
                  ? t(
                      `多参考图 vs 生成成品 · ${totalGridTiles} 宫格对比（${refList.length} 张参考图 + 1 张成品）`,
                      `Multi-Reference vs Output · ${totalGridTiles}-Tile Grid (${refList.length} refs + output)`
                    )
                  : t("参考原图 vs 生成成品 分屏对比", "Reference vs Generated Split Comparison")}
              </div>
              <div className="text-[11px] text-zinc-400 truncate">
                {detail.filename}
                {detail.workflow_name ? ` · ${detail.workflow_name}` : ""}
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {/* Reference picker when in 1v1 mode with multiple references */}
            {isMulti && mode !== "grid" && (
              <div className="flex items-center gap-1 rounded-lg bg-[#0a0d14] border border-zinc-800 p-0.5 text-[11px]">
                {refList.map((r, idx) => (
                  <button
                    key={r.url}
                    type="button"
                    onClick={() => setActiveRefIdx(idx)}
                    title={r.label || r.filename}
                    className={`px-2 py-1 rounded-md font-medium transition-colors ${
                      idx === activeRefIdx ? "bg-amber-500/85 text-black" : "text-zinc-400 hover:text-zinc-100"
                    }`}
                  >
                    {t(`参考${idx + 1}`, `Ref ${idx + 1}`)}
                  </button>
                ))}
              </div>
            )}

            {/* Mode Switcher */}
            <div className="flex items-center rounded-lg bg-[#0a0d14] border border-zinc-800 p-0.5 text-[11px]">
              {isMulti && (
                <button
                  type="button"
                  onClick={() => setMode("grid")}
                  className={`px-2.5 py-1 rounded-md flex items-center gap-1 font-medium transition-colors ${
                    mode === "grid" ? "bg-indigo-600 text-white" : "text-zinc-400 hover:text-zinc-100"
                  }`}
                >
                  <LayoutGrid className="w-3.5 h-3.5" />
                  {t(`${totalGridTiles}宫格`, `${totalGridTiles}-Grid`)}
                </button>
              )}
              <button
                type="button"
                onClick={() => setMode("split")}
                className={`px-2.5 py-1 rounded-md flex items-center gap-1 font-medium transition-colors ${
                  mode === "split" ? "bg-indigo-600 text-white" : "text-zinc-400 hover:text-zinc-100"
                }`}
              >
                <Columns2 className="w-3.5 h-3.5" />
                {t("左右分屏", "Side-by-Side")}
              </button>
              {detail.media_type !== "video" && (
                <button
                  type="button"
                  onClick={() => setMode("slider")}
                  className={`px-2.5 py-1 rounded-md flex items-center gap-1 font-medium transition-colors ${
                    mode === "slider" ? "bg-indigo-600 text-white" : "text-zinc-400 hover:text-zinc-100"
                  }`}
                >
                  <SlidersHorizontal className="w-3.5 h-3.5" />
                  {t("滑块叠加", "Overlay Slider")}
                </button>
              )}
            </div>

            {mode === "split" && (
              <button
                type="button"
                onClick={() => setZoomFull((v) => !v)}
                className="px-2.5 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-[11px] text-zinc-200 flex items-center gap-1"
              >
                {zoomFull ? <ZoomOut className="w-3.5 h-3.5" /> : <ZoomIn className="w-3.5 h-3.5" />}
                {zoomFull ? t("适应窗口", "Fit") : t("原图滚动", "100%")}
              </button>
            )}

            {onOpenRemix && ("has_raw_prompt" in detail ? detail.has_raw_prompt : true) && (
              <button
                type="button"
                onClick={() => {
                  onClose();
                  onOpenRemix();
                }}
                className="px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-[11px] font-semibold text-white flex items-center gap-1.5"
              >
                <Wand2 className="w-3.5 h-3.5" />
                {t("微调此图", "Remix Output")}
              </button>
            )}

            <button
              type="button"
              onClick={onClose}
              className="p-1.5 rounded-lg hover:bg-zinc-800 text-zinc-400 hover:text-white"
              title="Esc"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Comparison Viewport */}
        {mode === "grid" ? (
          /* N-Grid Mode: Ref 1 .. Ref K, Output Last */
          <div
            className={`flex-1 min-h-0 overflow-y-auto p-3 grid ${gridColsClass} gap-3 bg-[#07090e] auto-rows-[minmax(260px,1fr)]`}
          >
            {refList.map((refItem, idx) => {
              const dims = refDimsMap[refItem.url];
              return (
                <div
                  key={`${refItem.url}-${idx}`}
                  className="rounded-xl border border-zinc-800 bg-[#0d111a] flex flex-col min-h-0 overflow-hidden"
                >
                  <div className="px-3 py-1.5 bg-[#121725] border-b border-zinc-800/80 flex items-center justify-between gap-2 text-[11px] shrink-0">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className="px-2 py-0.5 rounded bg-amber-500/15 border border-amber-500/40 text-amber-200 font-semibold shrink-0">
                        {t(`参考图 ${idx + 1}`, `Ref ${idx + 1}`)}
                      </span>
                      <span className="text-zinc-300 truncate" title={refItem.label || refItem.filename}>
                        {refItem.label || refItem.filename}
                      </span>
                    </div>
                    {dims && (
                      <span className="text-zinc-400 font-mono shrink-0">
                        {dims.w}×{dims.h}
                      </span>
                    )}
                  </div>
                  <div className="flex-1 min-h-0 flex items-center justify-center p-2 overflow-hidden bg-[#07090e]">
                    <img
                      src={refItem.url}
                      alt={refItem.label || `Reference ${idx + 1}`}
                      onLoad={(e) => recordRefDims(refItem.url, e.currentTarget)}
                      className="max-w-full max-h-full object-contain rounded-lg"
                    />
                  </div>
                </div>
              );
            })}

            {/* Last tile: Generated Output */}
            <div className="rounded-xl border border-indigo-500/60 ring-1 ring-indigo-500/30 bg-[#0d111a] flex flex-col min-h-0 overflow-hidden">
              <div className="px-3 py-1.5 bg-indigo-950/50 border-b border-indigo-500/30 flex items-center justify-between gap-2 text-[11px] shrink-0">
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className="px-2 py-0.5 rounded bg-indigo-500/25 border border-indigo-400/50 text-indigo-100 font-semibold shrink-0">
                    {t("成品图", "Output")}
                  </span>
                  <span className="text-zinc-200 truncate" title={detail.filename}>
                    {detail.filename}
                  </span>
                </div>
                <span className="text-indigo-200/80 font-mono shrink-0">
                  {detail.width}×{detail.height}
                </span>
              </div>
              <div className="flex-1 min-h-0 flex items-center justify-center p-2 overflow-hidden bg-[#07090e]">
                {detail.media_type === "video" ? (
                  <video
                    src={detail.media_url}
                    controls
                    autoPlay
                    playsInline
                    className="max-w-full max-h-full object-contain rounded-lg"
                  />
                ) : (
                  <img
                    src={detail.media_url}
                    alt={detail.filename}
                    className="max-w-full max-h-full object-contain rounded-lg"
                  />
                )}
              </div>
            </div>
          </div>
        ) : mode === "split" ? (
          /* Side-by-Side Split Mode */
          <div className="flex-1 min-h-0 grid grid-cols-1 md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-zinc-800 bg-[#07090e]">
            {/* Left: Reference Image */}
            <div className="relative flex flex-col min-h-0 overflow-hidden">
              <div className="px-3 py-1.5 bg-[#0d111a]/90 border-b border-zinc-800/80 flex items-center justify-between gap-2 text-[11px] shrink-0">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="px-2 py-0.5 rounded bg-amber-500/15 border border-amber-500/40 text-amber-200 font-semibold shrink-0">
                    {isMulti
                      ? t(`左 · 参考图 ${activeRefIdx + 1}`, `Left · Ref ${activeRefIdx + 1}`)
                      : t("左 · 参考原图", "Left · Reference Image")}
                  </span>
                  {activeRef.label && (
                    <span className="text-zinc-400 truncate" title={activeRef.label}>
                      {activeRef.label}
                    </span>
                  )}
                </div>
                {activeRefDims && (
                  <span className="text-zinc-400 font-mono shrink-0">
                    {activeRefDims.w}×{activeRefDims.h}
                  </span>
                )}
              </div>
              <div
                className={`flex-1 min-h-0 flex items-center justify-center p-2 ${
                  zoomFull ? "overflow-auto items-start justify-start" : "overflow-hidden"
                }`}
              >
                <img
                  src={activeRef.url}
                  alt={activeRef.label || "Reference"}
                  onLoad={(e) => recordRefDims(activeRef.url, e.currentTarget)}
                  className={zoomFull ? "max-w-none" : "max-w-full max-h-full object-contain rounded-lg"}
                />
              </div>
            </div>

            {/* Right: Generated Image */}
            <div className="relative flex flex-col min-h-0 overflow-hidden">
              <div className="px-3 py-1.5 bg-[#0d111a]/90 border-b border-zinc-800/80 flex items-center justify-between text-[11px] shrink-0">
                <span className="px-2 py-0.5 rounded bg-indigo-500/20 border border-indigo-500/45 text-indigo-200 font-semibold">
                  {t("右 · 生成成品图", "Right · Generated Output")}
                </span>
                <span className="text-zinc-400 font-mono">
                  {detail.width}×{detail.height}
                </span>
              </div>
              <div
                className={`flex-1 min-h-0 flex items-center justify-center p-2 ${
                  zoomFull ? "overflow-auto items-start justify-start" : "overflow-hidden"
                }`}
              >
                {detail.media_type === "video" ? (
                  <video
                    src={detail.media_url}
                    controls
                    autoPlay
                    playsInline
                    className="max-w-full max-h-full object-contain rounded-lg"
                  />
                ) : (
                  <img
                    src={detail.media_url}
                    alt={detail.filename}
                    className={zoomFull ? "max-w-none" : "max-w-full max-h-full object-contain rounded-lg"}
                  />
                )}
              </div>
            </div>
          </div>
        ) : (
          /* Overlay Slider Mode */
          <div className="flex-1 min-h-0 flex flex-col bg-[#07090e] p-4 gap-3">
            <div className="relative flex-1 min-h-0 w-full flex items-center justify-center overflow-hidden rounded-xl border border-zinc-800 bg-black/50 select-none">
              <img
                src={detail.media_url}
                alt={detail.filename}
                className="max-w-full max-h-full object-contain pointer-events-none"
              />
              <div
                className="absolute inset-0 flex items-center justify-center overflow-hidden pointer-events-none"
                style={{ clipPath: `inset(0 ${100 - sliderPos}% 0 0)` }}
              >
                <img
                  src={activeRef.url}
                  alt={activeRef.label || "Reference"}
                  className="max-w-full max-h-full object-contain"
                />
              </div>
              {/* Vertical divider line */}
              <div
                className="absolute top-0 bottom-0 w-0.5 bg-indigo-400 shadow-[0_0_10px_rgba(99,102,241,0.9)] pointer-events-none"
                style={{ left: `${sliderPos}%` }}
              />
              <span className="absolute top-3 left-3 px-2 py-0.5 rounded bg-black/70 border border-amber-500/40 text-[11px] text-amber-200 font-semibold pointer-events-none">
                {isMulti ? t(`参考图 ${activeRefIdx + 1}`, `Ref ${activeRefIdx + 1}`) : t("原图", "Reference")}
              </span>
              <span className="absolute top-3 right-3 px-2 py-0.5 rounded bg-black/70 border border-indigo-500/40 text-[11px] text-indigo-200 font-semibold pointer-events-none">
                {t("成品图", "Generated")}
              </span>
            </div>
            <div className="flex items-center gap-3 px-2 shrink-0">
              <span className="text-[11px] text-amber-300 shrink-0">{t("原图", "Ref")}</span>
              <input
                type="range"
                min={0}
                max={100}
                value={sliderPos}
                onChange={(e) => setSliderPos(Number(e.target.value))}
                className="flex-1 accent-indigo-500"
              />
              <span className="text-[11px] text-indigo-300 shrink-0">{t("成品图", "Out")}</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
