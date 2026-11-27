import React, { useEffect, useMemo, useState } from "react";
import { Columns2, GitCompare, SlidersHorizontal, X } from "lucide-react";
import { api, formatTime } from "../api";
import { useI18n } from "../i18n";
import type { AssetDetail } from "../types";
import { diffPromptText } from "../utils/diff";

interface Props {
  assetIds: [number, number];
  onClose: () => void;
}

export const CompareModal: React.FC<Props> = ({ assetIds, onClose }) => {
  const { t } = useI18n();
  const [a, setA] = useState<AssetDetail | null>(null);
  const [b, setB] = useState<AssetDetail | null>(null);
  const [mode, setMode] = useState<"side" | "slider">("side");
  const [splitPct, setSplitPct] = useState(50);

  useEffect(() => {
    window.dispatchEvent(new CustomEvent("comfyvault:pause-bg-videos"));
    Promise.all([api.getAssetDetail(assetIds[0]), api.getAssetDetail(assetIds[1])]).then(([da, db]) => {
      setA(da);
      setB(db);
    });
  }, [assetIds[0], assetIds[1]]);

  const promptDiff = useMemo(() => {
    if (!a || !b) return [];
    const textA = a.prompts.map((p) => `[${p.node_title}] ${p.text}`).join("\n");
    const textB = b.prompts.map((p) => `[${p.node_title}] ${p.text}`).join("\n");
    return diffPromptText(textA, textB);
  }, [a, b]);

  const loraDiffRows = useMemo(() => {
    if (!a || !b) return [];
    const mapA = new Map(a.loras.map((l) => [l.name, l]));
    const mapB = new Map(b.loras.map((l) => [l.name, l]));
    const allNames = Array.from(new Set([...mapA.keys(), ...mapB.keys()]));
    return allNames.map((name) => {
      const la = mapA.get(name);
      const lb = mapB.get(name);
      const valA = la ? (la.enabled ? `${la.strength_model}` : t("关闭", "Off")) : t("未使用", "Unused");
      const valB = lb ? (lb.enabled ? `${lb.strength_model}` : t("关闭", "Off")) : t("未使用", "Unused");
      return { name, valA, valB, changed: valA !== valB };
    });
  }, [a, b, t]);

  const paramRows = useMemo(() => {
    if (!a || !b) return [];
    const rows: Array<[string, string, string]> = [
      [t("生成时间", "Created"), formatTime(a.created_at), formatTime(b.created_at)],
      [t("底模", "Base Model"), a.base_model?.split("/").pop() || "-", b.base_model?.split("/").pop() || "-"],
      [t("工作流", "Workflow"), a.workflow_name || "-", b.workflow_name || "-"],
      [t("ComfyUI 版本", "ComfyUI Version"), a.comfy_version || "-", b.comfy_version || "-"],
      [t("分辨率", "Resolution"), `${a.width}×${a.height}`, `${b.width}×${b.height}`],
      ["Seed", String(a.params.seed ?? "-"), String(b.params.seed ?? "-")],
      ["Steps", String(a.params.steps ?? "-"), String(b.params.steps ?? "-")],
      ["CFG / Guidance", String(a.params.cfg ?? a.params.guidance ?? "-"), String(b.params.cfg ?? b.params.guidance ?? "-")],
      ["Sampler", String(a.params.sampler ?? "-"), String(b.params.sampler ?? "-")],
      ["Scheduler", String(a.params.scheduler ?? "-"), String(b.params.scheduler ?? "-")],
    ];
    return rows;
  }, [a, b, t]);

  if (!a || !b) {
    return (
      <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center text-zinc-300 text-sm">
        {t("正在加载 A/B 对比数据...", "Loading A/B comparison data...")}
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/85 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="w-full max-w-6xl h-[92vh] bg-[#10131c] border border-zinc-700/80 rounded-2xl shadow-2xl flex flex-col overflow-hidden">
        {/* Header */}
        <div className="px-5 py-3 border-b border-zinc-800 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <GitCompare className="w-4 h-4 text-indigo-400" />
            <span className="text-sm font-semibold text-white">{t("A/B 视觉对比 & 参数/提示词 Diff", "A/B Visual Compare & Params/Prompt Diff")}</span>
          </div>
          <div className="flex items-center gap-2">
            {a.media_type === "image" && b.media_type === "image" && (
              <div className="flex bg-zinc-900 p-0.5 rounded-lg border border-zinc-800 text-xs">
                <button
                  type="button"
                  onClick={() => setMode("side")}
                  className={`px-2.5 py-1 rounded flex items-center gap-1 ${
                    mode === "side" ? "bg-indigo-600 text-white" : "text-zinc-400"
                  }`}
                >
                  <Columns2 className="w-3.5 h-3.5" /> {t("并排对比", "Side by Side")}
                </button>
                <button
                  type="button"
                  onClick={() => setMode("slider")}
                  className={`px-2.5 py-1 rounded flex items-center gap-1 ${
                    mode === "slider" ? "bg-indigo-600 text-white" : "text-zinc-400"
                  }`}
                >
                  <SlidersHorizontal className="w-3.5 h-3.5" /> {t("卷帘滑块", "Split Slider")}
                </button>
              </div>
            )}
            <button type="button" onClick={onClose} className="p-1.5 rounded-lg hover:bg-zinc-800 text-zinc-400">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Scrollable Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          {/* Visual Comparison */}
          {mode === "side" ? (
            <div className="grid grid-cols-2 gap-4">
              {[
                { label: t("A (基准)", "A (Base)"), item: a, badge: "bg-rose-500/20 text-rose-300 border-rose-500/40" },
                { label: t("B (对照)", "B (Compare)"), item: b, badge: "bg-emerald-500/20 text-emerald-300 border-emerald-500/40" },
              ].map(({ label, item, badge }) => (
                <div key={item.id} className="rounded-xl bg-[#090b10] border border-zinc-800 overflow-hidden flex flex-col">
                  <div className="px-3 py-1.5 bg-[#151926] border-b border-zinc-800 flex items-center justify-between text-xs">
                    <span className={`px-2 py-0.5 rounded border text-[11px] font-medium ${badge}`}>{label}</span>
                    <span className="text-zinc-300 truncate ml-2">{item.filename}</span>
                  </div>
                  <div className="h-[360px] flex items-center justify-center p-2">
                    {item.media_type === "video" ? (
                      <video src={item.media_url} controls autoPlay muted playsInline className="max-h-full max-w-full" />
                    ) : (
                      <img src={item.media_url} alt={item.filename} className="max-h-full max-w-full object-contain" />
                    )}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="flex flex-col items-center gap-3">
              <div className="relative w-full max-w-2xl h-[420px] bg-[#090b10] rounded-xl overflow-hidden border border-zinc-800 select-none">
                <img src={b.media_url} alt={b.filename} className="absolute inset-0 w-full h-full object-contain" />
                <div
                  className="absolute inset-0 overflow-hidden"
                  style={{ clipPath: `inset(0 ${100 - splitPct}% 0 0)` }}
                >
                  <img src={a.media_url} alt={a.filename} className="w-full h-full object-contain" />
                </div>
                <div
                  className="absolute top-0 bottom-0 w-0.5 bg-indigo-400 shadow-[0_0_8px_#818cf8]"
                  style={{ left: `${splitPct}%` }}
                />
                <span className="absolute top-2 left-2 px-2 py-0.5 rounded bg-black/75 text-[11px] text-rose-300">
                  A: {a.filename}
                </span>
                <span className="absolute top-2 right-2 px-2 py-0.5 rounded bg-black/75 text-[11px] text-emerald-300">
                  B: {b.filename}
                </span>
              </div>
              <input
                type="range"
                min={0}
                max={100}
                value={splitPct}
                onChange={(e) => setSplitPct(Number(e.target.value))}
                className="w-96 accent-indigo-500"
              />
            </div>
          )}

          {/* Prompt Diff */}
          <div className="rounded-xl bg-[#141824] border border-zinc-800 overflow-hidden">
            <div className="px-4 py-2 bg-[#191e2d] border-b border-zinc-800 flex items-center justify-between text-xs">
              <span className="font-semibold text-zinc-200">{t("提示词差异高亮 (A → B)", "Prompt Diff Highlight (A → B)")}</span>
              <div className="flex items-center gap-3 text-[11px]">
                <span className="text-rose-300 bg-rose-500/20 px-1.5 py-0.5 rounded line-through">{t("A 中有 / B 删除", "Removed in B")}</span>
                <span className="text-emerald-300 bg-emerald-500/20 px-1.5 py-0.5 rounded">{t("B 中新增", "Added in B")}</span>
              </div>
            </div>
            <div className="p-4 text-xs leading-relaxed whitespace-pre-wrap break-words font-sans max-h-56 overflow-y-auto">
              {promptDiff.map((tok, i) => {
                if (tok.type === "added") {
                  return (
                    <span key={i} className="bg-emerald-500/25 text-emerald-200 px-0.5 rounded">
                      {tok.text}
                    </span>
                  );
                }
                if (tok.type === "removed") {
                  return (
                    <span key={i} className="bg-rose-500/25 text-rose-200 line-through px-0.5 rounded">
                      {tok.text}
                    </span>
                  );
                }
                return (
                  <span key={i} className="text-zinc-400">
                    {tok.text}
                  </span>
                );
              })}
            </div>
          </div>

          {/* LoRA & Param Diff Tables */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="rounded-xl bg-[#141824] border border-zinc-800 overflow-hidden">
              <div className="px-4 py-2 bg-[#191e2d] border-b border-zinc-800 text-xs font-semibold text-purple-300">
                {t("LoRA 权重对比", "LoRA Weight Comparison")}
              </div>
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-zinc-500 border-b border-zinc-800 text-left">
                    <th className="py-2 px-3">LoRA</th>
                    <th className="py-2 px-3">A</th>
                    <th className="py-2 px-3">B</th>
                  </tr>
                </thead>
                <tbody>
                  {loraDiffRows.length === 0 ? (
                    <tr>
                      <td colSpan={3} className="py-4 text-center text-zinc-500">
                        {t("两者均未挂载 LoRA", "Neither asset uses any LoRA")}
                      </td>
                    </tr>
                  ) : (
                    loraDiffRows.map((r) => (
                      <tr
                        key={r.name}
                        className={`border-b border-zinc-800/60 ${r.changed ? "bg-amber-500/10" : ""}`}
                      >
                        <td className="py-1.5 px-3 text-zinc-200 truncate max-w-[200px]" title={r.name}>
                          {r.name.split("/").pop()}
                        </td>
                        <td className="py-1.5 px-3 font-mono text-rose-200">{r.valA}</td>
                        <td className="py-1.5 px-3 font-mono text-emerald-200">{r.valB}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            <div className="rounded-xl bg-[#141824] border border-zinc-800 overflow-hidden">
              <div className="px-4 py-2 bg-[#191e2d] border-b border-zinc-800 text-xs font-semibold text-sky-300">
                {t("核心参数对比", "Core Parameters Comparison")}
              </div>
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-zinc-500 border-b border-zinc-800 text-left">
                    <th className="py-2 px-3">{t("参数项", "Parameter")}</th>
                    <th className="py-2 px-3">A</th>
                    <th className="py-2 px-3">B</th>
                  </tr>
                </thead>
                <tbody>
                  {paramRows.map(([k, va, vb]) => {
                    const diff = va !== vb;
                    return (
                      <tr key={k} className={`border-b border-zinc-800/60 ${diff ? "bg-amber-500/10" : ""}`}>
                        <td className="py-1.5 px-3 text-zinc-400">{k}</td>
                        <td className="py-1.5 px-3 font-mono text-zinc-200 truncate max-w-[160px]" title={va}>
                          {va}
                        </td>
                        <td className="py-1.5 px-3 font-mono text-zinc-200 truncate max-w-[160px]" title={vb}>
                          {vb}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
