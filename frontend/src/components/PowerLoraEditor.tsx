import React, { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Plus, Search, Sliders, Trash2, X } from "lucide-react";
import { useI18n } from "../i18n";

export interface RgthreeLoraEntry {
  on: boolean;
  lora: string;
  strength: number;
  strengthTwo?: number | null;
}

interface Props {
  nodeInputs: Record<string, any>;
  availableLoras: string[];
  autoRanges?: Record<string, { min: number; max: number; source?: string }>;
  onReplaceNodeInputs: (nextInputs: Record<string, any>) => void;
}

interface LoraRange {
  min: number;
  max: number;
}

const SLIDER_LORA_RE = /slider|size|breast|muscle|age|weight|height|bust|waist|hip|scale|detail|lighting|contrast/i;
const RANGE_STORAGE_KEY = "comfyvault_lora_ranges";

function loadCustomRanges(): Record<string, LoraRange> {
  try {
    const raw = localStorage.getItem(RANGE_STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function getEffectiveRange(
  loraName: string,
  curVal: number,
  customRanges: Record<string, LoraRange>,
  autoRanges?: Record<string, LoraRange>
): LoraRange {
  const norm = loraName.replace(/\\/g, "/");
  const custom = customRanges[loraName] || customRanges[norm];
  const auto = autoRanges?.[loraName] || autoRanges?.[norm];
  let base: LoraRange;
  if (custom && typeof custom.min === "number" && typeof custom.max === "number" && custom.max > custom.min) {
    base = custom;
  } else if (auto && typeof auto.min === "number" && typeof auto.max === "number" && auto.max > auto.min) {
    base = auto;
  } else if (SLIDER_LORA_RE.test(loraName)) {
    base = { min: -5, max: 8 };
  } else {
    base = { min: -2, max: 2 };
  }
  return {
    min: Math.min(base.min, Math.floor(curVal)),
    max: Math.max(base.max, Math.ceil(curVal)),
  };
}

/**
 * Full-featured editor for Power Lora Loader (rgthree):
 * toggle on/off, editable numeric weight, smart + per-LoRA customizable slider range,
 * reorder up/down, delete, and add new LoRA from ComfyUI!
 */
export const PowerLoraEditor: React.FC<Props> = ({
  nodeInputs,
  availableLoras,
  autoRanges,
  onReplaceNodeInputs,
}) => {
  const { t } = useI18n();
  const [adding, setAdding] = useState(false);
  const [search, setSearch] = useState("");
  const [customRanges, setCustomRanges] = useState<Record<string, LoraRange>>(loadCustomRanges);
  const [editingRangeLora, setEditingRangeLora] = useState<string | null>(null);
  const [rangeMinDraft, setRangeMinDraft] = useState("-5");
  const [rangeMaxDraft, setRangeMaxDraft] = useState("8");

  const loraList = useMemo(() => {
    return Object.entries(nodeInputs)
      .filter(([k, v]) => k.startsWith("lora_") && /^\d+$/.test(k.slice(5)) && v && typeof v === "object" && "lora" in v)
      .sort((a, b) => Number(a[0].slice(5)) - Number(b[0].slice(5)))
      .map(([, v]) => ({
        on: Boolean(v.on ?? true),
        lora: String(v.lora || ""),
        strength: Number(v.strength ?? 1.0),
        strengthTwo: v.strengthTwo ?? null,
      }));
  }, [nodeInputs]);

  const commitList = (nextList: RgthreeLoraEntry[]) => {
    const nextInputs: Record<string, any> = {};
    for (const [k, v] of Object.entries(nodeInputs)) {
      if (!(k.startsWith("lora_") && /^\d+$/.test(k.slice(5)))) {
        nextInputs[k] = v;
      }
    }
    nextList.forEach((item, idx) => {
      const entry: Record<string, any> = {
        on: item.on,
        lora: item.lora,
        strength: item.strength,
      };
      if (item.strengthTwo !== null && item.strengthTwo !== undefined) {
        entry.strengthTwo = item.strengthTwo;
      }
      nextInputs[`lora_${idx + 1}`] = entry;
    });
    onReplaceNodeInputs(nextInputs);
  };

  const updateAt = (idx: number, patch: Partial<RgthreeLoraEntry>) => {
    commitList(loraList.map((it, i) => (i === idx ? { ...it, ...patch } : it)));
  };

  const move = (idx: number, dir: -1 | 1) => {
    const target = idx + dir;
    if (target < 0 || target >= loraList.length) return;
    const copy = [...loraList];
    const tmp = copy[idx];
    copy[idx] = copy[target];
    copy[target] = tmp;
    commitList(copy);
  };

  const removeAt = (idx: number) => {
    commitList(loraList.filter((_, i) => i !== idx));
  };

  const addLora = (loraName: string) => {
    commitList([...loraList, { on: true, lora: loraName, strength: 0.8 }]);
    setAdding(false);
    setSearch("");
  };

  const openRangeEditor = (loraName: string, curRange: LoraRange) => {
    if (editingRangeLora === loraName) {
      setEditingRangeLora(null);
      return;
    }
    setEditingRangeLora(loraName);
    setRangeMinDraft(String(curRange.min));
    setRangeMaxDraft(String(curRange.max));
  };

  const saveRange = (loraName: string) => {
    const mn = Number(rangeMinDraft);
    const mx = Number(rangeMaxDraft);
    if (Number.isNaN(mn) || Number.isNaN(mx) || mx <= mn) return;
    setCustomRanges((prev) => {
      const next = { ...prev, [loraName]: { min: mn, max: mx } };
      try {
        localStorage.setItem(RANGE_STORAGE_KEY, JSON.stringify(next));
      } catch {}
      return next;
    });
    setEditingRangeLora(null);
  };

  const filteredLoras = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = q ? availableLoras.filter((l) => l.toLowerCase().includes(q)) : availableLoras;
    return list.slice(0, 80);
  }, [availableLoras, search]);

  return (
    <div className="sm:col-span-2 md:col-span-2 space-y-2">
      {loraList.map((item, idx) => {
        const range = getEffectiveRange(item.lora, item.strength, customRanges, autoRanges);
        const span = range.max - range.min;
        const step = span > 6 ? 0.1 : 0.05;
        const isEditingRange = editingRangeLora === item.lora;

        return (
          <div
            key={`${idx}-${item.lora}`}
            className={`p-2.5 rounded-lg bg-[#0d1018] border transition-colors space-y-1.5 ${
              item.on ? "border-purple-500/35" : "border-zinc-800/80 opacity-70"
            }`}
          >
            <div className="flex items-center justify-between gap-2">
              <label className="flex items-center gap-2 min-w-0 flex-1 cursor-pointer">
                <input
                  type="checkbox"
                  checked={item.on}
                  onChange={(e) => updateAt(idx, { on: e.target.checked })}
                  className="accent-purple-500 shrink-0"
                />
                <span className="text-[11px] font-mono text-zinc-200 truncate" title={item.lora}>
                  {item.lora.split(/[\\/]/).pop() || item.lora}
                </span>
              </label>

              {/* Editable Strength + Custom Range + Reorder + Delete */}
              <div className="flex items-center gap-1 shrink-0">
                <input
                  type="number"
                  step={step}
                  value={item.strength}
                  onChange={(e) => {
                    const v = e.target.value === "" ? 0 : Number(e.target.value);
                    if (!Number.isNaN(v)) updateAt(idx, { strength: v });
                  }}
                  title={t("可直接输入任意权重数值", "Enter any weight value directly")}
                  className="w-14 h-6 px-1.5 rounded bg-[#141926] border border-zinc-700 focus:border-purple-500 focus:outline-none text-right font-mono text-[11px] text-purple-300"
                />
                <button
                  type="button"
                  onClick={() => openRangeEditor(item.lora, range)}
                  title={t(
                    `自定义此 LoRA 的滑块上下限（当前 ${range.min} ~ ${range.max}）`,
                    `Customize slider range for this LoRA (current: ${range.min} ~ ${range.max})`
                  )}
                  className={`px-1.5 h-6 rounded text-[10px] font-mono flex items-center gap-0.5 border transition-colors ${
                    isEditingRange
                      ? "bg-purple-600/30 border-purple-400 text-purple-200"
                      : "bg-zinc-900 border-zinc-800 text-zinc-400 hover:text-purple-300"
                  }`}
                >
                  <Sliders className="w-2.5 h-2.5" />
                  {range.min}~{range.max}
                </button>
                <button
                  type="button"
                  disabled={idx === 0}
                  onClick={() => move(idx, -1)}
                  title={t("上移", "Move up")}
                  className="p-1 rounded hover:bg-zinc-800 text-zinc-400 hover:text-zinc-100 disabled:opacity-25"
                >
                  <ArrowUp className="w-3 h-3" />
                </button>
                <button
                  type="button"
                  disabled={idx === loraList.length - 1}
                  onClick={() => move(idx, 1)}
                  title={t("下移", "Move down")}
                  className="p-1 rounded hover:bg-zinc-800 text-zinc-400 hover:text-zinc-100 disabled:opacity-25"
                >
                  <ArrowDown className="w-3 h-3" />
                </button>
                <button
                  type="button"
                  onClick={() => removeAt(idx)}
                  title={t("删除此 LoRA", "Remove this LoRA")}
                  className="p-1 rounded hover:bg-rose-600/25 text-zinc-500 hover:text-rose-300"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>
            </div>

            {isEditingRange && (
              <div className="flex items-center justify-end gap-1.5 pt-1 text-[11px]">
                <span className="text-zinc-400">{t("滑块范围：", "Slider range:")}</span>
                <input
                  type="number"
                  step="0.5"
                  value={rangeMinDraft}
                  onChange={(e) => setRangeMinDraft(e.target.value)}
                  className="w-16 h-6 px-1.5 rounded bg-[#141926] border border-zinc-700 text-xs font-mono text-zinc-100"
                />
                <span className="text-zinc-500">~</span>
                <input
                  type="number"
                  step="0.5"
                  value={rangeMaxDraft}
                  onChange={(e) => setRangeMaxDraft(e.target.value)}
                  className="w-16 h-6 px-1.5 rounded bg-[#141926] border border-zinc-700 text-xs font-mono text-zinc-100"
                />
                <button
                  type="button"
                  onClick={() => saveRange(item.lora)}
                  className="px-2 h-6 rounded bg-purple-600 hover:bg-purple-500 text-white text-[11px]"
                >
                  {t("保存范围", "Save range")}
                </button>
              </div>
            )}

            <input
              type="range"
              min={range.min}
              max={range.max}
              step={step}
              disabled={!item.on}
              value={item.strength}
              onChange={(e) => updateAt(idx, { strength: Number(e.target.value) })}
              className="w-full accent-purple-500"
            />
          </div>
        );
      })}

      {/* Add LoRA Trigger / Inline Searchable Picker */}
      {!adding ? (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="w-full py-1.5 rounded-lg border border-dashed border-purple-500/40 hover:border-purple-400 hover:bg-purple-600/15 text-xs text-purple-300 flex items-center justify-center gap-1.5 transition-colors"
        >
          <Plus className="w-3.5 h-3.5" />
          {t("添加 LoRA", "Add LoRA")}
        </button>
      ) : (
        <div className="p-2.5 rounded-lg bg-[#0b0e16] border border-purple-500/50 space-y-2">
          <div className="flex items-center gap-1.5">
            <div className="relative flex-1">
              <Search className="w-3.5 h-3.5 text-zinc-500 absolute left-2.5 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                autoFocus
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t("搜索本地 LoRA 文件名...", "Search local LoRA filenames...")}
                className="w-full h-7 pl-8 pr-2 rounded bg-[#141824] border border-zinc-700 focus:border-purple-500 focus:outline-none text-xs text-zinc-100"
              />
            </div>
            <button
              type="button"
              onClick={() => {
                setAdding(false);
                setSearch("");
              }}
              className="p-1 rounded hover:bg-zinc-800 text-zinc-400"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
          <div className="max-h-44 overflow-y-auto space-y-0.5">
            {filteredLoras.length === 0 ? (
              <div className="text-[11px] text-zinc-500 py-3 text-center">
                {t("未找到匹配的 LoRA 文件", "No matching LoRA files found")}
              </div>
            ) : (
              filteredLoras.map((name) => (
                <button
                  key={name}
                  type="button"
                  onClick={() => addLora(name)}
                  className="w-full text-left px-2 py-1 rounded hover:bg-purple-600/25 text-[11px] font-mono text-zinc-200 truncate"
                  title={name}
                >
                  {name}
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
};
