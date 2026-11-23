import React, { useEffect, useState } from "react";
import { ArrowRight, Layers, Search, Sparkles, Star } from "lucide-react";
import { api, formatTime } from "../api";
import type { LoraMatrixRow } from "../types";

interface Props {
  onSelectLora: (loraName: string) => void;
  onSelectAssetId: (assetId: number) => void;
}

export const LoraMatrixView: React.FC<Props> = ({ onSelectLora, onSelectAssetId }) => {
  const [rows, setRows] = useState<LoraMatrixRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");

  useEffect(() => {
    setLoading(true);
    api
      .getLoraMatrix()
      .then((res) => setRows(res.items))
      .finally(() => setLoading(false));
  }, []);

  const filtered = rows.filter((r) => r.lora_name.toLowerCase().includes(search.trim().toLowerCase()));

  return (
    <div className="flex-1 h-full overflow-y-auto p-6 bg-[#0b0d12]">
      <div className="max-w-7xl mx-auto space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-lg font-bold text-white flex items-center gap-2">
              <Sparkles className="w-5 h-5 text-purple-400" />
              人物 LoRA 专项档案
            </h1>
            <p className="text-xs text-zinc-400 mt-0.5">
              按 LoRA 文件聚合所有测试图与视频，直观对比不同 Epoch 的常用权重区间与出图精选率
            </p>
          </div>
          <div className="relative w-72">
            <Search className="w-3.5 h-3.5 text-zinc-500 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="筛选 LoRA 名称 / Epoch..."
              className="w-full h-9 pl-8 pr-3 rounded-lg bg-[#141722] border border-zinc-800 text-xs text-zinc-100 focus:outline-none focus:border-purple-500"
            />
          </div>
        </div>

        {loading ? (
          <div className="py-16 text-center text-zinc-500 text-sm">正在聚合 LoRA 档案...</div>
        ) : filtered.length === 0 ? (
          <div className="py-16 text-center text-zinc-500 text-sm">
            暂无 LoRA 使用记录（请确保资源库已完成扫描）
          </div>
        ) : (
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
            {filtered.map((row) => {
              const short = row.lora_name.split("/").pop() || row.lora_name;
              return (
                <div
                  key={row.lora_name}
                  className="p-4 rounded-2xl bg-[#131722] border border-zinc-800/90 hover:border-purple-500/40 transition-colors space-y-3"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-sm font-semibold text-purple-200 truncate" title={row.lora_name}>
                        {short}
                      </div>
                      <div className="text-[11px] text-zinc-500 truncate">{row.lora_name}</div>
                    </div>
                    <button
                      type="button"
                      onClick={() => onSelectLora(row.lora_name)}
                      className="px-2.5 py-1 rounded-lg bg-purple-600/20 hover:bg-purple-600/40 border border-purple-500/30 text-[11px] text-purple-200 flex items-center gap-1 shrink-0"
                    >
                      查看全部 ({row.total_count}) <ArrowRight className="w-3 h-3" />
                    </button>
                  </div>

                  {/* Stats Row */}
                  <div className="grid grid-cols-4 gap-2 text-[11px]">
                    <div className="px-2.5 py-1.5 rounded-lg bg-[#0c0f17] border border-zinc-800/80">
                      <div className="text-zinc-500">总出图</div>
                      <div className="text-zinc-100 font-mono font-semibold">{row.total_count}</div>
                    </div>
                    <div className="px-2.5 py-1.5 rounded-lg bg-[#0c0f17] border border-zinc-800/80">
                      <div className="text-zinc-500">精选率</div>
                      <div className="text-emerald-300 font-mono font-semibold">
                        {row.pick_rate}% ({row.pick_count})
                      </div>
                    </div>
                    <div className="px-2.5 py-1.5 rounded-lg bg-[#0c0f17] border border-zinc-800/80">
                      <div className="text-zinc-500">权重区间</div>
                      <div className="text-purple-300 font-mono font-semibold">
                        {row.min_strength} ~ {row.max_strength}
                      </div>
                    </div>
                    <div className="px-2.5 py-1.5 rounded-lg bg-[#0c0f17] border border-zinc-800/80">
                      <div className="text-zinc-500">最近使用</div>
                      <div className="text-zinc-300 font-mono truncate">{formatTime(row.last_used).slice(5, 16)}</div>
                    </div>
                  </div>

                  {/* Top Samples */}
                  <div className="grid grid-cols-6 gap-2">
                    {row.samples.map((s) => (
                      <button
                        key={s.id}
                        type="button"
                        onClick={() => onSelectAssetId(s.id)}
                        className="group relative aspect-square rounded-lg overflow-hidden bg-[#0a0c12] border border-zinc-800 hover:border-indigo-400"
                        title={`${s.filename} | 权重: ${s.strength_model}`}
                      >
                        <img src={s.thumb_url} alt={s.filename} loading="lazy" className="w-full h-full object-cover" />
                        <span className="absolute bottom-0.5 left-0.5 px-1 rounded bg-black/75 text-[9px] font-mono text-purple-200">
                          {s.strength_model}
                        </span>
                        {s.rating > 0 && (
                          <span className="absolute top-0.5 right-0.5 px-1 rounded bg-black/75 text-[9px] text-amber-400 flex items-center">
                            <Star className="w-2.5 h-2.5 fill-amber-400" />
                            {s.rating}
                          </span>
                        )}
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};
